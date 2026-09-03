/**
 * Map loot — grab loot piles, dropped items, and carcasses directly off the
 * canvas.
 *
 * A token is "grabbable" when its actor is a `loot` pile OR the token is
 * DEFEATED (a carcass — dead status or a defeated combatant). When the player's
 * assigned token sits within one grid square (gridless: the equivalent
 * distance) of a grabbable token, the grabbable token is FAINTLY highlighted
 * and a left-click opens the appropriate UI:
 *
 *   • loot pile / defeated character → a compact take-list (per-item Take, Take
 *     All, coins). Every take is proxied to the GM (emitGiftItem /
 *     emitTakeAllLoot / emitTransferLootCurrency) so player permissions on the
 *     loot/corpse actor never matter.
 *   • defeated monster (people OR not) → the carcass context menu (people: Loot
 *     / Take Trophy; others: harvest / dissect / extract / take-carcass). A
 *     monster's loot lives on its `remains` item (rolled from system.loot). The
 *     remains is embedded on the (GM-owned) monster token, so its mutations are
 *     GM-proxied too (emitRemainsMutate / emitRemainsSpendCharge) — carcass
 *     actions work for players even for a bestiary token with no world actor.
 *
 * This is the TOKEN-mode path. The theater-of-mind sidebar `remains` item
 * (monster-remains.js) is unchanged; token mode is an additional surface.
 */

import { getAssignedActor, isActorInActiveCombat } from "../chrome/lib/actor.js";
import { canSpendCombatAction, chargeCombatAction, occupancyOf } from "../chrome/chrome/inventory.js";
import { emitGiftItem, emitTakeAllLoot, emitTransferLootCurrency, emitDropWorldItemAsTile, emitTakeTileItem, emitDeleteCorpseToken } from "../setup/socketHook.mjs";
import { isEnabled as immersiveCameraOn } from "../policy/immersive-token-camera.mjs";
import { isOverlayVisible as movementOverlayOpen } from "../policy/immersive-tactical-grid.mjs";
import { isTargetingActive } from "../policy/weapon-target-overlay.mjs";

/** Loot clicks/keys are fully suppressed while the movement-plot overlay or the
 *  weapon-targeting overlay is open — a click on a tile must NOT double as a
 *  loot grab (both immersive AND default mode). */
function lootInteractionBlocked() {
  try { if (movementOverlayOpen?.()) return true; } catch (_) {}
  try { if (isTargetingActive?.()) return true; } catch (_) {}
  return false;
}
import { buildItemActionEntries } from "../chrome/chrome/context-menu-item.js";
import { t, tFormat } from "../chrome/lib/i18n.js";

const SYSTEM_ID = "witcher-ttrpg-death-march";
const REACH_TILES = 1;        // "adjacent" = within one grid square / equivalent

/* ───────────────────────── detection ───────────────────────── */

function isTile(o) { return o?.document?.documentName === "Tile"; }

/** World rectangle actually covered by a TILE's image. Tiles default to a CENTER
 *  texture anchor (anchorX/Y = 0.5), and Tile#_refreshPosition puts the mesh at
 *  document.x/y — so document.x/y is the image CENTER, not its top-left. Resolve
 *  the anchor-aware center so highlight + hit-test line up with the picture
 *  (also correct if a GM sets a non-centered anchor). */
function tileVisualRect(tile) {
  const d = tile?.document;
  if (!d) return null;
  const w = Number(d.width) || 0, h = Number(d.height) || 0;
  const ax = Number(d.texture?.anchorX ?? 0.5), ay = Number(d.texture?.anchorY ?? 0.5);
  const cx = (Number(d.x) || 0) + (0.5 - ax) * w;
  const cy = (Number(d.y) || 0) + (0.5 - ay) * h;
  return { cx, cy, w, h, x1: cx - w / 2, y1: cy - h / 2, x2: cx + w / 2, y2: cy + h / 2 };
}

/** Scene-pixel bounds of a placeable — a token (live/animated coords) OR a loot
 *  tile (anchor-aware visual rect). */
function placeableBounds(o) {
  if (!o) return null;
  if (isTile(o)) { const r = tileVisualRect(o); return r ? { x1: r.x1, y1: r.y1, x2: r.x2, y2: r.y2 } : null; }
  const x = Number(o.x) || 0, y = Number(o.y) || 0;
  const w = Number(o.w) || Number(o.width) || 0;
  const h = Number(o.h) || Number(o.height) || 0;
  return { x1: x, y1: y, x2: x + w, y2: y + h };
}

/** Edge-to-edge gap between two placeables, in GRID TILES. Gridded → Chebyshev
 *  (diagonal counts as one), gridless → Euclidean, both in tile units. 0 =
 *  touching. Infinity when there's no measurable grid. */
function tokenGapTiles(a, b) {
  const ab = placeableBounds(a), bb = placeableBounds(b);
  if (!ab || !bb) return Infinity;
  const size = Number(canvas?.scene?.grid?.size) || 0;
  if (size <= 0) return Infinity;
  const dx = Math.max(0, ab.x1 - bb.x2, bb.x1 - ab.x2);
  const dy = Math.max(0, ab.y1 - bb.y2, bb.y1 - ab.y2);
  const gridless = (canvas?.scene?.grid?.type ?? 0) === 0;
  return (gridless ? Math.hypot(dx, dy) : Math.max(dx, dy)) / size;
}

/** True when the token reads as a corpse: the `dead` status on its actor, or a
 *  combatant flagged defeated in the tracker. */
function isTokenDefeated(token) {
  const actor = token?.actor;
  if (!actor) return false;
  if (actor.statuses?.has?.("dead")) return true;
  const combatant = token?.combatant
    ?? game.combat?.combatants?.find?.(c => c.tokenId === token?.id);
  return !!combatant?.isDefeated;
}

/** What kind of grabbable is this token, or null if it isn't one:
 *   "loot"          — a loot-pile actor (also a dropped-item ground pile)
 *   "character"     — a defeated PC (loot ALL its items)
 *   "monster-people"— a defeated is-people monster (carcass menu: Loot / Take
 *                     Trophy — its loot rolls from system.loot on the remains)
 *   "monster"       — a defeated non-people monster (carcass menu: harvest /
 *                     dissect / extract / take-carcass) */
function grabbableKind(token) {
  const actor = token?.actor;
  if (!actor) return null;
  if (actor.type === "loot") return "loot";
  if (!isTokenDefeated(token)) return null;
  if (actor.type === "character") return "character";
  if (actor.type === "monster") return actor.system?.isPeople ? "monster-people" : "monster";
  return null;
}

/** The token the user is DRIVING: their single controlled token, else their
 *  assigned character's token. Everything targets THIS token's actor — loot
 *  goes to it, autopsy/harvest checks come from it — so controlling a companion
 *  loots to the companion even while you're "assigned" a different PC. */
function playerToken() {
  const ctrl = canvas?.tokens?.controlled ?? [];
  if (ctrl.length === 1) return ctrl[0];
  return getAssignedActor()?.getActiveTokens?.()?.[0] ?? null;
}
function playerActor() { return playerToken()?.actor ?? getAssignedActor() ?? null; }

/** Adjacent = occupying a NEIGHBORING tile (touching — gap 0). Gridless: within
 *  one tile's distance. A one-tile gap is NOT adjacent. */
function isAdjacent(me, token) {
  const gap = tokenGapTiles(me, token);
  const gridless = (canvas?.scene?.grid?.type ?? 0) === 0;
  return gridless ? gap <= REACH_TILES + 1e-3 : gap < REACH_TILES - 1e-3;
}

/** The grabbable kind if `token` is grabbable AND the driving token `me` is
 *  adjacent (and it isn't `me`'s own token). Null otherwise. `me` is passed in
 *  so a full sweep resolves the driving token ONCE. */
function grabbableFor(token, me) {
  const kind = grabbableKind(token);
  if (!kind) return null;
  if (!me || me.id === token.id) return null;
  if (token.actor && me.actor && token.actor.id === me.actor.id) return null;   // don't loot yourself
  if (!isAdjacent(me, token)) return null;
  if (!lootInView(token)) return null;   // outside the driving token's vision → not lootable
  return kind;
}

/** Loot behind fog / outside the driving player's current vision must not be
 *  interactable or cued — you can't grab what you can't see. Uses Foundry's own
 *  point-visibility test (a GM or a vision-disabled scene reports everything
 *  visible, so this is a no-op there). Fails OPEN on any error so a quirk can
 *  never make reachable loot un-grabbable. */
function _lootInViewUncached(placeable) {
  try {
    const c = placeable?.center;
    if (!c || !Number.isFinite(c.x) || !Number.isFinite(c.y)) return true;
    const vis = canvas?.visibility;
    if (vis && typeof vis.testVisibility === "function") {
      return !!vis.testVisibility(c, { object: placeable, tolerance: 0 });
    }
    return placeable?.visible !== false;
  } catch (_) { return true; }
}

/* testVisibility is the ONE genuinely expensive call on the loot hot path (a
 * vision/wall raycast, several ms on a wall-heavy scene). Moving into range
 * fires the sweep 2–3× back-to-back (refreshToken cell-cross, then updateToken
 * at rest, then the ~420ms facing settle), and each used to re-test every
 * adjacent lootable from scratch — that stack of redundant raycasts is the
 * residual hitch. A loot object's in-view/fogged status can only change when
 * the VIEWER moves to a different cell or a wall/light is edited, so memoize the
 * result keyed on the viewer's cell and reuse it across the redundant sweeps.
 * Invalidated on wall edits (doors) and scene ready; the viewer-cell key
 * auto-invalidates the moment the driving token actually moves. */
let _visCacheSig = null;
const _visCache = new Map();   // placeable.id -> boolean (in view)
function invalidateVisCache() { _visCacheSig = null; _visCache.clear(); }
function lootInView(placeable) {
  let sig = null;
  try { const vc = cellOf(playerToken()?.center); sig = vc ? `${vc.i},${vc.j}` : null; } catch (_) { sig = null; }
  // Only trust the cache when we have a stable viewer-cell key; a null key
  // (no token / gridless quirk) falls through to a fresh test every time.
  if (sig === null) return _lootInViewUncached(placeable);
  if (sig !== _visCacheSig) { _visCache.clear(); _visCacheSig = sig; }
  const id = placeable?.id;
  if (id && _visCache.has(id)) return _visCache.get(id);
  const v = _lootInViewUncached(placeable);
  if (id) _visCache.set(id, v);
  return v;
}
function grabbableAndAdjacent(token) { return grabbableFor(token, playerToken()); }

/** A tile marked as loot (canvas-drop snapshot OR a Tile-Config-assigned item). */
function tileIsLoot(tile) {
  const f = tile?.document?.flags?.[SYSTEM_ID];
  return !!(f?.isLoot && (f.lootData || f.lootUuid));
}

/** Display name / icon / quantity for a loot tile, from its stored snapshot or
 *  the Tile-Config-assigned metadata (falling back to the tile texture). */
function tileLootMeta(tile) {
  const f = tile?.document?.flags?.[SYSTEM_ID] ?? {};
  const data = f.lootData ?? null;
  return {
    name: f.lootName ?? data?.name ?? "item",
    img:  f.lootImg  ?? data?.img  ?? tile?.document?.texture?.src ?? "icons/svg/item-bag.svg",
    qty:  Math.max(1, Number(data?.system?.quantity) || 1),
  };
}

/** The item data behind a loot tile: the canvas-drop snapshot, else the
 *  Tile-Config-assigned item resolved from its uuid. Used to tell if the tile is
 *  an equippable weapon. */
function tileItemData(tile) {
  const f = tile?.document?.flags?.[SYSTEM_ID] ?? {};
  if (f.lootData) return f.lootData;
  if (f.lootUuid) { try { return fromUuidSync(f.lootUuid)?.toObject?.(false) ?? null; } catch (_) { return null; } }
  return null;
}

/** True if this loot tile is a weapon the recipient could equip right now. */
function tileWeaponEquippable(tile, recipient) {
  const data = tileItemData(tile);
  if (data?.type !== "weapon") return false;
  return canEquipWeapon(recipient, { type: "weapon", system: { hands: data?.system?.hands } });
}

/** Take the tile's weapon AND equip it into a free hand on landing (mirrors
 *  takeAndEquip for actor loot). takeTile handles the transfer + the combat
 *  action; we just equip the created weapon once it appears on the recipient. */
async function takeTileAndEquip(tile, recipient) {
  const data = tileItemData(tile);
  const name = tile?.document?.flags?.[SYSTEM_ID]?.lootName ?? data?.name;
  const hf = handsFree(recipient);
  const slot = data?.system?.hands === "two" ? "right" : (hf.right ? "right" : "left");
  const onCreated = async (created) => {
    try {
      if (created?.parent?.id !== recipient.id) return;
      if (created.type !== "weapon" || created.name !== name || created.system?.equipped) return;
      Hooks.off("createItem", onCreated);
      await created.update({ "system.equipped": true, "system.slot": slot });
    } catch (_) { /* normalization owns the rest */ }
  };
  Hooks.on("createItem", onCreated);
  await takeTile(tile);
  setTimeout(() => { try { Hooks.off("createItem", onCreated); } catch (_) {} }, 4000);
}

/** Pick up a ground-item tile → its item goes to the driving token's actor, the
 *  tile is removed (both GM-routed). Costs one Action in combat. */
async function takeTile(tile) {
  const recipient = playerActor();
  if (!recipient) { ui.notifications?.warn?.(t("WITCHER.Chrome.MapLoot.Notify.NoCharacter", "Assign / control a character first.")); return; }
  if (!canSpendCombatAction(recipient)) return;   // no action left in combat → abort (warns)
  const name = tile?.document?.flags?.[SYSTEM_ID]?.lootName ?? "item";
  emitTakeTileItem({ sceneId: canvas?.scene?.id, tileId: tile.id, targetActorUuid: recipient.uuid });
  await chargeCombatAction(recipient, `Loot: ${name}`);
}

/* ───── loot highlight: amber ART TINT (no ring halo, either mode) ─────
 * A lootable's ART is tinted amber (a multiply on its mesh). NON-immersive →
 * every adjacent lootable is tinted; IMMERSIVE camera → only the lootable in the
 * ONE cell the token faces is tinted, and a "[E] Loot" prompt shows over it (E
 * opens a combined menu for everything in that cell). Tint pins across Foundry's
 * per-refresh mesh.tint reset via the _refreshMesh wrap (patchMeshTint). */
const TINT_COLOR = 0xFFA023;   // strong warm amber (multiply) — clearly reads as "lootable"

function immersiveActive(me) {
  try { return !!me && !isActorInActiveCombat(me?.actor) && !!immersiveCameraOn?.(); }
  catch (_) { return false; }
}

/** The object's own base mesh tint (document texture tint), to restore on clear. */
function meshBaseTint(obj) {
  const raw = obj?.document?.texture?.tint;
  if (raw == null || raw === "") return 0xFFFFFF;
  try { const C = foundry?.utils?.Color; return typeof raw === "number" ? raw : (C?.from ? C.from(raw).valueOf() : 0xFFFFFF); }
  catch (_) { return 0xFFFFFF; }
}

/** Flag an object for the amber art tint (and apply it now). Foundry rewrites
 *  mesh.tint inside _refreshMesh every refresh, so the persistent re-assert is
 *  done by the _refreshMesh wrap (patchMeshTint) — the same pin-through-refresh
 *  trick dead-token-zorder uses for mesh.sort. This just sets the flag + the
 *  immediate value so there's no one-frame gap. */
function setLootTint(obj, on) {
  obj._wdmLootTintWant = !!on;
  const mesh = obj?.mesh;
  if (!mesh) return;
  if (on) { if (mesh.tint !== TINT_COLOR) mesh.tint = TINT_COLOR; }
  else if (mesh.tint === TINT_COLOR) { try { mesh.tint = meshBaseTint(obj); } catch (_) {} }
}

/* Re-assert the amber tint AFTER Foundry's _refreshMesh resets mesh.tint to the
 * document tint — otherwise the tint flickers off on any refresh (hover, vision
 * change, the immersive camera's per-frame token refreshes, …). Wrapped once on
 * both Token and Tile prototypes. */
function patchMeshTint() {
  const wrap = (Cls) => {
    if (!Cls || Cls.prototype.__wdmLootTintPatched) return;
    Cls.prototype.__wdmLootTintPatched = true;
    const orig = Cls.prototype._refreshMesh;
    Cls.prototype._refreshMesh = function _refreshMeshLootTint(...args) {
      const r = orig?.apply(this, args);
      if (this._wdmLootTintWant && this.mesh && this.mesh.tint !== TINT_COLOR) {
        try { this.mesh.tint = TINT_COLOR; } catch (_) {}
      }
      return r;
    };
  };
  wrap(foundry?.canvas?.placeables?.Token);
  wrap(foundry?.canvas?.placeables?.Tile);
}

/** World center of a loot object (tile: anchor-aware visual center; token: center). */
function objCenter(obj) {
  if (isTile(obj)) { const r = tileVisualRect(obj); return r ? { x: r.cx, y: r.cy } : null; }
  return obj?.center ?? null;
}
function cellOf(pt) { try { return pt ? (canvas?.grid?.getOffset?.(pt) ?? null) : null; } catch (_) { return null; } }

/** The (row,col) delta of the single cell the token faces. Foundry rotation 0 =
 *  facing south; facing vector = (-sin, cos). Rounded to an 8-way neighbour. */
function facingDelta(me) {
  const rad = (Number(me?.document?.rotation) || 0) * Math.PI / 180;
  return { dj: Math.round(-Math.sin(rad)), di: Math.round(Math.cos(rad)) };   // dj=col, di=row
}
function isInFacedCell(me, obj, faced) {
  const oc = cellOf(objCenter(obj));
  return !!(faced && oc && oc.i === faced.i && oc.j === faced.j);
}

/* Immersive INTERACT key — registered as a rebindable Foundry keybinding in
 * policy/immersive-token-camera.mjs ("immersiveInteract", default F). Read here
 * so BOTH the keydown handler and the on-screen prompt track the user's current
 * binding. All lookups fail safe to F. */
const INTERACT_ACTION = "immersiveInteract";
function interactKeyCode() {
  try {
    // A USER-customized binding lives in game.keybindings.get(); an unmodified
    // one returns [] there (Foundry keeps defaults in the action config), so
    // fall back to the registered `editable` default before the hardcoded F.
    const custom = game.keybindings?.get?.(SYSTEM_ID, INTERACT_ACTION);
    if (Array.isArray(custom) && custom[0]?.key) return custom[0].key;
    const cfg = game.keybindings?.actions?.get?.(`${SYSTEM_ID}.${INTERACT_ACTION}`);
    const def = cfg?.editable?.[0]?.key;
    if (def) return def;
  } catch (_) { /* not registered yet / lookup threw → fall through */ }
  return "KeyF";
}
/** Human-readable label for the bound interact key (e.g. "KeyF" → "F"), for the prompt. */
function interactKeyLabel() {
  const code = interactKeyCode();
  try {
    const KM = foundry?.helpers?.interaction?.KeyboardManager ?? globalThis.KeyboardManager;
    const s = KM?.getKeycodeDisplayString?.(code);
    if (s) return s;
  } catch (_) {}
  return String(code).replace(/^Key/, "").replace(/^Digit/, "");
}
/** True if a keydown event is the (unmodified) interact key. */
function eventIsInteract(ev) {
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return false;
  return ev.code === interactKeyCode();
}

/** The interact-key loot / door prompt DOM element, positioned in screen space over the faced cell. */
let _lootPromptEl = null;
let _facedLoot = [];          // loot objects in the currently-faced cell (for the interact handler)
let _facedWorldPt = null;     // world center of the faced cell (repositioned on pan)
function ensureLootPromptStyle() {
  if (document.getElementById("wdm-loot-prompt-style")) return;
  const st = document.createElement("style");
  st.id = "wdm-loot-prompt-style";
  st.textContent = `
    #wdm-loot-prompt { position:fixed; z-index:118; transform:translate(-50%,-140%); pointer-events:none;
      display:none; align-items:center; gap:0.3rem; padding:0.15rem 0.5rem;
      background:linear-gradient(180deg, rgba(22,18,13,0.95), rgba(10,9,8,0.95));
      border:1px solid var(--wdm-amber-dim,#6e5224); border-radius:4px;
      color:var(--wdm-ink-hi,#e0dac4); font-family:var(--wdm-font-display); font-size:0.72rem;
      letter-spacing:0.08em; text-transform:uppercase; white-space:nowrap;
      box-shadow:0 0.3rem 0.8rem rgba(0,0,0,0.7); }
    #wdm-loot-prompt .key { display:inline-block; min-width:1.1em; text-align:center; padding:0 0.25em;
      background:var(--wdm-amber-hi,#b89464); color:#161208; border-radius:3px; font-weight:700; }
  `;
  document.head.appendChild(st);
}
function positionLootPrompt() {
  const el = _lootPromptEl;
  if (!el) return;
  if (!_facedWorldPt) { el.style.display = "none"; return; }
  let p = null;
  try { p = canvas?.stage?.toGlobal?.(new PIXI.Point(_facedWorldPt.x, _facedWorldPt.y)); } catch (_) { p = null; }
  if (!p) { el.style.display = "none"; return; }
  // Same UI-scaling group as the loot windows: `data-wdm-scaled` applies
  // `zoom: var(--wdm-popup-scale, …)`, so divide the visual-px position by that
  // var to land in css-px (identical to positionPanel).
  el.style.left = `calc(${Math.round(p.x)}px / ${ZOOM_VAR})`;
  el.style.top  = `calc(${Math.round(p.y)}px / ${ZOOM_VAR})`;
  el.style.display = "flex";
}
function showPrompt(worldPt, label) {
  ensureLootPromptStyle();
  if (!_lootPromptEl || !document.body.contains(_lootPromptEl)) {
    const el = document.createElement("div");
    el.id = "wdm-loot-prompt";
    el.setAttribute("data-wdm-scaled", "1");   // scale with the loot-window UI-scaling group
    document.body.appendChild(el);
    _lootPromptEl = el;
  }
  const html = `<span class="key">${esc(interactKeyLabel())}</span> ${esc(label)}`;
  if (_lootPromptEl.innerHTML !== html) _lootPromptEl.innerHTML = html;
  _facedWorldPt = worldPt;
  positionLootPrompt();
}
function hideLootPrompt() { _facedWorldPt = null; if (_lootPromptEl) _lootPromptEl.style.display = "none"; }

/* ── doors (immersive) ── Foundry's door control icon is hidden in immersive
 * mode; instead the faced door in reach shows an "[E] Open / Close" prompt and
 * E toggles it. A "door" is a wall of type DOOR (SECRET too, GM only). */
let _facedDoor = null;

/** The DOOR wall the token faces + is adjacent to, or null. Same 8-way facing as
 *  loot: the door's midpoint must be within ~1 tile AND roughly in front. */
function facedDoor(me) {
  if (!me || !canvas?.walls) return null;
  const c = me.center; if (!c) return null;
  const gs = Number(canvas.grid?.size) || 100;
  const rad = (Number(me.document?.rotation) || 0) * Math.PI / 180;
  const fx = -Math.sin(rad), fy = Math.cos(rad);
  const DOOR = CONST.WALL_DOOR_TYPES?.DOOR ?? 1, SECRET = CONST.WALL_DOOR_TYPES?.SECRET ?? 2;
  let best = null, bestScore = -Infinity;
  for (const wall of (canvas.walls.placeables ?? [])) {
    const dt = wall.document?.door;
    if (dt !== DOOR && !(dt === SECRET && game.user?.isGM)) continue;
    const cc = wall.document?.c; if (!cc) continue;
    const mx = (cc[0] + cc[2]) / 2, my = (cc[1] + cc[3]) / 2;
    const dx = mx - c.x, dy = my - c.y;
    const dist = Math.hypot(dx, dy);
    if (dist > gs * 1.25) continue;                 // not adjacent
    const dot = dist > 1 ? (dx * fx + dy * fy) / dist : 1;
    if (dot < 0.35) continue;                        // not in front (~within 70° of facing)
    const score = dot - dist / gs;                   // prefer aligned + close
    if (score > bestScore) { bestScore = score; best = wall; }
  }
  return best;
}
function doorMidpoint(wall) { const cc = wall?.document?.c; return cc ? { x: (cc[0] + cc[2]) / 2, y: (cc[1] + cc[3]) / 2 } : null; }
function doorIsOpen(wall) { return wall?.document?.ds === (CONST.WALL_DOOR_STATES?.OPEN ?? 1); }
async function toggleDoor(wall, actor = null) {
  if (!wall?.isDoor) return;
  const states = CONST.WALL_DOOR_STATES ?? { CLOSED: 0, OPEN: 1, LOCKED: 2 };
  const ds = wall.document?.ds;
  if (ds === states.LOCKED) { try { wall._playDoorSound?.("test"); } catch (_) {} return; }   // locked → just rattle
  if (!game.user?.can?.("WALL_DOORS")) { ui.notifications?.warn?.(t("WITCHER.Chrome.MapLoot.Notify.NoDoors", "You can't operate doors.")); return; }
  // Operating a door in combat costs one Action (free out of combat).
  const inCombat = (() => { try { return !!actor && isActorInActiveCombat(actor); } catch (_) { return false; } })();
  if (inCombat && !canSpendCombatAction(actor)) return;   // no action left → abort (warns)
  const opening = ds === states.CLOSED;
  try { await wall.document.update({ ds: opening ? states.OPEN : states.CLOSED }, { sound: true }); }
  catch (_) { return; }
  if (inCombat) await chargeCombatAction(actor, opening ? "Open door" : "Close door");
}
/** Hide/show Foundry's whole door-control icon container. Redraws re-add children
 *  to the (still-hidden) container, so setting visible once + re-asserting each
 *  sweep is enough. */
function setDoorControlsVisible(v) { const d = canvas?.controls?.doors; if (d && d.visible !== v) d.visible = v; }

/** Apply/refresh THIS object's loot visual from its cached flags. Two modes:
 *  immersive → amber ART tint (no halo); otherwise → the ring halo (no tint).
 *  Signature-gated for the halo so a per-frame refresh costs one string compare. */
function applyLootVisual(obj) {
  if (!obj || obj.destroyed) return;
  const want = !!obj._wdmMapLootWant;
  // Hot common case (nearly every object): nothing wanted and no tint applied.
  if (!want && !obj._wdmLootTintWant) return;
  // Amber ART tint in BOTH modes now (the ring halo is gone). Immersive → the
  // faced lootable only; non-immersive → every adjacent lootable (the sweep sets
  // `want` accordingly). The _refreshMesh wrap keeps mesh.tint pinned.
  setLootTint(obj, want);
}

let _rafPending = false;
function scheduleRefresh() {
  if (_rafPending) return;
  _rafPending = true;
  requestAnimationFrame(() => { _rafPending = false; try { refreshAllHighlights(); } catch (_) {} });
}

/** True if a moving `token` can actually change the loot glow, which depends
 *  only on the PLAYER's own position/facing and their wall-based vision — not
 *  on where other creatures walk. So a full re-sweep is warranted only when:
 *    • the player's own token moved (their reach/facing/vision changed), or
 *    • the moved token IS a loot target now (a rare draggable loot token
 *      entering reach), or was one last sweep (moving out → clear its glow).
 *  Any other token crossing a cell used to trigger a full all-tiles
 *  testVisibility sweep — the ~half-FPS drop when someone else moves in view. */
function isLootRelevantToken(token) {
  const me = playerToken();
  if (!token || !me) return true;                 // unknown state → be safe, sweep
  if (token === me || token.id === me.id) return true;
  if (token._wdmMapLootWant) return true;          // was glowing → re-sweep to update/clear
  try { return !!grabbableFor(token, me); } catch (_) { return true; }
}

/** Recompute adjacency for every loot object, cache the want/immersive/faced
 *  flags, and apply the visual. In immersive mode also resolve the faced cell
 *  and update the "[E] Loot" prompt + the faced-loot list the E handler uses. */
function refreshAllHighlights() {
  const me = playerToken();
  // The cue only appears OUT of combat — in combat you know to reach for loot,
  // and grabbing it costs an action. (Click/take still work; only the cue is off.)
  const showGlow = !isActorInActiveCombat(me?.actor);
  const immersive = immersiveActive(me);
  const meCell = immersive ? cellOf(me?.center) : null;
  const facedCell = (immersive && meCell) ? (() => { const d = facingDelta(me); return { i: meCell.i + d.di, j: meCell.j + d.dj }; })() : null;
  const faced = [];

  // Immersive: the amber tint is applied ONLY to the lootable(s) in the FACED
  // cell (not every adjacent one). Non-immersive: the halo shows on every
  // adjacent lootable, as before.
  const sweep = (obj, lootable) => {
    let want = lootable;
    if (immersive) {
      want = lootable && isInFacedCell(me, obj, facedCell);
      if (want) faced.push(obj);
    }
    obj._wdmMapLootWant = want;
    applyLootVisual(obj);
  };

  for (const token of (canvas?.tokens?.placeables ?? [])) {
    let lootable = false;
    if (showGlow) { try { lootable = !!grabbableFor(token, me); } catch (_) { lootable = false; } }
    sweep(token, lootable);
  }
  for (const tile of (canvas?.tiles?.placeables ?? [])) {
    let lootable = false;
    if (showGlow && me) { try { lootable = tileIsLoot(tile) && isAdjacent(me, tile) && lootInView(tile); } catch (_) { lootable = false; } }
    sweep(tile, lootable);
  }

  _facedLoot = faced;

  // Doors key off the immersive CAMERA setting, NOT the OOC-gated `immersive`
  // flag — otherwise the icons reappear the instant combat starts (loot tint is
  // OOC-only by design; door hiding must persist in combat too). Hide Foundry's
  // door icons whenever the camera is on and use our own faced-door prompt.
  const cameraOn = !!(me && (() => { try { return immersiveCameraOn?.(); } catch (_) { return false; } })());
  try { setDoorControlsVisible(!cameraOn); } catch (_) {}
  const fdoor = cameraOn ? facedDoor(me) : null;
  _facedDoor = fdoor;

  // One prompt. A faced DOOR wins over faced loot ("[E] Open/Close" vs
  // "[E] Loot"), and the DOOR prompt shows even with the movement overlay open —
  // doors are operable on your turn (costing an Action). The loot prompt still
  // yields to an overlay that owns clicks.
  const blocked = (() => { try { return lootInteractionBlocked(); } catch (_) { return false; } })();
  if (cameraOn && fdoor) {
    const mid = doorMidpoint(fdoor);
    if (mid) showPrompt(mid, doorIsOpen(fdoor) ? t("WITCHER.Chrome.MapLoot.Text.Close", "Close") : t("WITCHER.Chrome.MapLoot.Text.Open", "Open"));
    else hideLootPrompt();
  } else if (!blocked && immersive && faced.length && facedCell) {
    let ctr = null; try { ctr = canvas?.grid?.getCenterPoint?.(facedCell); } catch (_) { ctr = null; }
    if (ctr) showPrompt(ctr, t("WITCHER.Chrome.MapLoot.Text.Loot", "Loot")); else hideLootPrompt();
  } else {
    hideLootPrompt();
  }

  try { closeTakeListIfOutOfReach(); } catch (_) {}
}

/* Immersive camera pans every frame while following the token; keep the DOM
 * prompt glued to the faced cell without a full sweep. */
function onLootCanvasPan() { if (!_facedWorldPt) return; try { positionLootPrompt(); } catch (_) {} }

/* Press the interact key, facing a lootable cell / door → loot the cell or
 * toggle the door. The key is user-rebindable (see interactKeyCode). */
function onLootKeydown(ev) {
  try {
    if (ev.repeat) return;
    if (!eventIsInteract(ev)) return;
    const el = ev.target;
    if (el && (el.isContentEditable || el.matches?.("input, textarea, select, [contenteditable]"))) return;
    const me = playerToken();
    if (!me) return;
    const cameraOn = (() => { try { return !!immersiveCameraOn?.(); } catch (_) { return false; } })();
    if (!cameraOn) return;
    // Faced door takes priority and works in AND out of combat — even while the
    // movement overlay is open (E is a keyboard action, not a movement click).
    // Costs an Action in combat.
    if (_facedDoor && !_facedDoor.destroyed) { ev.preventDefault(); ev.stopPropagation(); toggleDoor(_facedDoor, me.actor); return; }
    // Loot: OOC only, yields to an overlay that owns clicks. ALL lootables in the
    // faced cell coalesce into one flat menu (take + equip), reusing the standard
    // helpers so peace-vs-combat action costs are identical.
    if (!lootInteractionBlocked() && immersiveActive(me) && _facedLoot.length) {
      ev.preventDefault(); ev.stopPropagation();
      openCombinedLoot(_facedLoot.slice());
    }
  } catch (_) { /* non-fatal */ }
}

/* ─────────────────────── click interception ─────────────────────── */

/* Loot clicks arrive on TWO layers, because a token's own interactivity decides
 * who sees the click first:
 *
 *  • INTERACTABLE tokens (eventMode "static" — e.g. a dead monster/character on
 *    the active token layer with the select tool) capture the pointer at the
 *    TARGET phase and run their own selection via their MouseInteractionManager
 *    (→ Token#_onClickLeft → control()). A canvas-stage listener only sees the
 *    event on the later BUBBLE phase — too late to stop selection. So we patch
 *    Token#_onClickLeft itself: for a grabbable+adjacent token we open the loot
 *    UI and return WITHOUT calling super, so no selection happens.
 *
 *  • NON-INTERACTABLE tokens (eventMode "none" — loot piles a player can't
 *    control) don't capture the pointer at all; the event falls through to
 *    canvas.stage, where wireMapLootPointer hit-tests and handles them (this is
 *    also the only channel that works for loot TILES). That handler skips
 *    interactable tokens so the two paths never double-fire.  */

function patchTokenClick() {
  const TokenCls = foundry?.canvas?.placeables?.Token;
  if (!TokenCls || TokenCls.prototype.__wdmMapLootClick) return;
  TokenCls.prototype.__wdmMapLootClick = true;
  const orig = TokenCls.prototype._onClickLeft;
  TokenCls.prototype._onClickLeft = function _onClickLeftMapLoot(event) {
    try {
      // Movement-plot overlay open → a left click plots a move, it must NEVER
      // select a token. Skip super (which would control() → select) and let the
      // tactical grid's own stage handler consume the click for the move.
      if (movementOverlayOpen?.()) return;
      // Immersive camera: looting is E-only (the faced cell), never click.
      const kind = (lootInteractionBlocked() || immersiveActive(playerToken())) ? null : grabbableAndAdjacent(this);
      if (kind) {
        handleMapLootClick(this, kind);
        // Consume: skip super (no select) and stop the click bubbling to a ping.
        try { event?.stopPropagation?.(); } catch (_) {}
        try { event?.preventDefault?.(); } catch (_) {}
        return;
      }
    } catch (err) { console.warn(`${SYSTEM_ID} | map-loot click check failed`, err); }
    return orig?.call(this, event);
  };
}

/* Abort any in-progress board interaction so a loot click can't also become a
 * canvas PING. The board's MouseInteractionManager (target = canvas.stage)
 * arms a long-press timer on pointerdown → canvas.ping(); opening loot must
 * kill that timer + reset the manager, else clicking loot (esp. while the loot
 * window is already open) still fires a ping. The long-press timeout is a single
 * static field on the class, so we clear it directly too. */
function cancelCanvasPing() {
  try { canvas?.mouseInteractionManager?.cancel?.(); } catch (_) {}
  try {
    const M = foundry?.canvas?.interaction?.MouseInteractionManager;
    if (M?.longPressTimeout) { clearTimeout(M.longPressTimeout); M.longPressTimeout = null; }
  } catch (_) {}
}

function handleMapLootClick(token, kind) {
  cancelCanvasPing();
  // Both monster kinds → the carcass's remains menu; its registered actions
  // differ by is-people (Loot / Take Trophy vs harvest / dissect / extract),
  // and a monster's loot lives on the remains (rolled from system.loot), not
  // as embedded gear. The remains mutations are GM-proxied (emitRemainsMutate
  // / emitRemainsSpendCharge), so a player's permission on the corpse actor
  // never matters — even when the monster was dragged straight from the
  // bestiary and has no world actor entry.
  if (kind === "monster" || kind === "monster-people") { openCarcassContextMenu(token); return; }
  // loot pile → its items+coins; defeated character → all its carried items.
  openTakeList(token);
}

/* ─────────────────────── take-list popup (P2) ─────────────────────── */

let _panelEl = null;
let _panelTokenId = null;
let _panelTileId = null;   // set when the open panel belongs to a loot TILE (vs a token)
let _panelObjs = null;     // set for the COMBINED menu: the loot objects (tokens/tiles) it lists
let _panelOutside = null;
let _panelHooks = [];   // [ [hookName, fn], ... ] — removed on close

function esc(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("'", "&#39;")
    .replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

const COINS = ["crown", "oren", "bizant", "ducat", "lintar", "floren"];

/* Free-hand check reusing the inventory's occupancy model — a 1H weapon needs
 * one free hand, a 2H weapon ("two") needs both. */
function handsFree(actor) {
  let left = true, right = true;
  for (const it of (actor?.items?.contents ?? actor?.items ?? [])) {
    if (!it.system?.equipped) continue;
    let occ = null; try { occ = occupancyOf(it); } catch (_) { occ = null; }
    if (occ === "both") { left = right = false; }
    else if (occ === "right") right = false;
    else if (occ === "left") left = false;
  }
  return { left, right };
}
function canEquipWeapon(actor, weapon) {
  if (!actor || weapon?.type !== "weapon") return false;
  const hf = handsFree(actor);
  return weapon.system?.hands === "two" ? (hf.left && hf.right) : (hf.left || hf.right);
}

/* Take a weapon AND equip it into a free hand. The item is created on the
 * recipient GM-side (emitGiftItem); the looting player owns their own
 * character's items, so we equip it the instant it lands (createItem), letting
 * the system's equip normalization finish placing it. */
async function takeAndEquip(sourceActor, recipient, weapon) {
  const hf = handsFree(recipient);
  const slot = weapon.system?.hands === "two" ? "right" : (hf.right ? "right" : "left");
  const name = weapon.name, type = weapon.type;
  const onCreated = async (created) => {
    try {
      if (created?.parent?.id !== recipient.id) return;
      if (created.type !== type || created.name !== name || created.system?.equipped) return;
      Hooks.off("createItem", onCreated);
      await created.update({ "system.equipped": true, "system.slot": slot });
    } catch (_) { /* normalization owns the rest */ }
  };
  Hooks.on("createItem", onCreated);
  await emitGiftItem({ sourceActorUuid: sourceActor.uuid, targetActorUuid: recipient.uuid, itemId: weapon.id, quantity: 1, fromUserId: game.user?.id ?? null });
  setTimeout(() => { try { Hooks.off("createItem", onCreated); } catch (_) {} }, 4000);
}

function ensurePanelStyle() {
  if (document.getElementById("wdm-map-loot-style")) return;
  const style = document.createElement("style");
  style.id = "wdm-map-loot-style";
  style.textContent = `
    #wdm-map-loot { position: fixed; z-index: 120; min-width: 13rem; max-width: 18rem;
      max-height: 60vh; overflow-y: auto; padding: 0.4rem 0.5rem 0.5rem;
      background: linear-gradient(180deg, rgba(22,18,13,0.98), rgba(10,9,8,0.98));
      border: 1px solid var(--wdm-amber-dim, #6e5224); border-radius: 4px;
      box-shadow: 0 0.5rem 1.5rem rgba(0,0,0,0.8); color: var(--wdm-ink-hi, #e0dac4);
      font-family: var(--wdm-font-body); font-size: 0.8125rem; }
    #wdm-map-loot .wdm-ml-head { display:flex; align-items:center; gap:0.4rem;
      font-family: var(--wdm-font-display); font-size: 0.72rem; letter-spacing:0.14em;
      text-transform: uppercase; color: var(--wdm-amber-hi, #b89464);
      border-bottom: 1px dotted rgba(140,133,121,0.3); padding-bottom: 0.3rem; margin-bottom: 0.35rem; }
    #wdm-map-loot .wdm-ml-head .nm { flex:1 1 auto; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    #wdm-map-loot .wdm-ml-close { cursor:pointer; opacity:0.6; background:none; border:0; color:inherit; }
    #wdm-map-loot .wdm-ml-close:hover { opacity:1; }
    #wdm-map-loot ul { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:0.2rem; }
    #wdm-map-loot li { display:flex; align-items:center; gap:0.4rem; }
    #wdm-map-loot li.wdm-ml-container .nm { font-weight:600; color:var(--wdm-amber-hi, #b89464); }
    #wdm-map-loot li.wdm-ml-nested { margin-left:0.9rem; opacity:0.92; }
    #wdm-map-loot li.wdm-ml-nested::before { content:"\\21B3"; opacity:0.4; margin-right:0.1rem; }
    #wdm-map-loot img { width:1.4rem; height:1.4rem; object-fit:cover; border-radius:2px; flex:0 0 auto; }
    #wdm-map-loot .nm { flex:1 1 auto; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    #wdm-map-loot .qty { opacity:0.7; font-variant-numeric:tabular-nums; }
    #wdm-map-loot .wdm-ml-equip { cursor:pointer; background:rgba(120,160,90,0.16); border:1px solid rgba(120,160,90,0.45);
      color:var(--wdm-ink-hi, #e0dac4); border-radius:3px; padding:0.1rem 0.35rem; font-size:0.72rem; }
    #wdm-map-loot .wdm-ml-equip:hover { background:rgba(120,160,90,0.3); }
    #wdm-map-loot .wdm-ml-take, #wdm-map-loot .wdm-ml-takeall, #wdm-map-loot .wdm-ml-coin {
      cursor:pointer; background:rgba(200,168,120,0.14); border:1px solid rgba(200,168,120,0.4);
      color: var(--wdm-ink-hi, #e0dac4); border-radius:3px; padding:0.1rem 0.4rem; font-size:0.72rem;
      white-space:nowrap; }
    #wdm-map-loot .wdm-ml-take:hover, #wdm-map-loot .wdm-ml-takeall:hover, #wdm-map-loot .wdm-ml-coin:hover {
      background:rgba(200,168,120,0.28); }
    #wdm-map-loot .wdm-ml-coins { display:flex; flex-wrap:wrap; gap:0.25rem; margin-top:0.35rem;
      padding-top:0.35rem; border-top:1px dotted rgba(140,133,121,0.3); }
    #wdm-map-loot .wdm-ml-foot { margin-top:0.4rem; text-align:right; }
    #wdm-map-loot .wdm-ml-empty { opacity:0.6; font-style:italic; padding:0.4rem 0; }
    #wdm-map-loot .wdm-ml-actions { display:flex; flex-direction:column; gap:0.15rem; }
    #wdm-map-loot .wdm-ml-action { display:flex; align-items:center; gap:0.45rem; cursor:pointer;
      background:none; border:0; color:var(--wdm-ink-hi, #e0dac4); padding:0.28rem 0.3rem; border-radius:3px;
      text-align:left; font-size:0.8125rem; width:100%; }
    #wdm-map-loot .wdm-ml-action:hover { background:rgba(200,168,120,0.16); }
    #wdm-map-loot .wdm-ml-action i { color:var(--wdm-amber-hi, #b89464); width:1rem; text-align:center; flex:0 0 auto; }
    #wdm-map-loot .wdm-ml-action .nm { flex:1 1 auto; }
  `;
  document.head.appendChild(style);
}

/* Non-loot item types never shown in a corpse's loot window — spells, hexes,
 * rituals, character-build items, statuses, etc. (a corpse only yields physical
 * gear + coin). GM-curated loot ACTORS skip this filter (they hold whatever the
 * GM dropped in). */
const LOOT_EXCLUDE = new Set([
  "race", "homeland", "profession", "perk", "spell", "hex", "ritual",
  "skill", "criticalWound", "clue", "obstacle", "note", "remains"
]);

function byName(a, b) { return String(a?.name).localeCompare(String(b?.name)); }

/** Rows for the panel: the SEALED top-level items only. A container shows as a
 *  single row — its contents stay hidden until you take it and open it in your
 *  own inventory (no peeking). `filter` (corpse sources) drops non-loot types. */
function lootRows(actor, filter) {
  const items = (actor?.items?.contents ?? actor?.items ?? []);
  const top = items.filter(i => i && !i.system?.isStored).slice().sort(byName);
  const ok = (it) => it && (!filter || !LOOT_EXCLUDE.has(it.type));
  const rows = [];
  for (const it of top) {
    if (it.type === "container") rows.push({ item: it, kind: "container" });
    else if (ok(it)) rows.push({ item: it, kind: "item" });
  }
  return rows;
}

function renderPanelBody(actor) {
  const isLoot = actor?.type === "loot";
  const recipient = playerActor();
  const rows = lootRows(actor, !isLoot);   // corpses filter to physical gear
  const itemsHtml = rows.length
    ? `<ul>${rows.map(r => {
        const it = r.item;
        const qty = Math.max(1, Number(it.system?.quantity) || 1);
        const img = it.img || "icons/svg/item-bag.svg";
        const cls = r.kind === "nested" ? "wdm-ml-nested" : (r.kind === "container" ? "wdm-ml-container" : "");
        // A weapon can be taken & equipped straight into a free hand.
        const equipBtn = (it.type === "weapon" && canEquipWeapon(recipient, it))
          ? `<button type="button" class="wdm-ml-equip" data-item-id="${esc(it.id)}" title="${t("WITCHER.Chrome.MapLoot.Text.EquipFreeHand", "Take & equip to a free hand")}"><i class="fa-solid fa-hand-fist"></i></button>`
          : "";
        return `<li class="${cls}" data-item-id="${esc(it.id)}">
          <img src="${esc(img)}" alt="" draggable="false"/>
          <span class="nm" title="${esc(it.name)}">${esc(it.name)}</span>
          ${qty > 1 ? `<span class="qty">×${qty}</span>` : ""}
          ${equipBtn}
          <button type="button" class="wdm-ml-take" data-item-id="${esc(it.id)}">${t("WITCHER.Chrome.LootDisplay.Text.Take", "Take")}</button>
        </li>`;
      }).join("")}</ul>`
    : `<div class="wdm-ml-empty">${t("WITCHER.Chrome.MapLoot.Text.Empty", "Nothing left to take.")}</div>`;

  // Currency shows for any source that carries coin (loot piles AND corpses).
  const cur = actor?.system?.currency ?? {};
  const coins = COINS.map(k => ({ k, v: Number(cur[k]) || 0 })).filter(c => c.v > 0);
  const capCoin = (k) => String(k).charAt(0).toUpperCase() + String(k).slice(1);
  const coinsHtml = coins.length
    ? `<div class="wdm-ml-coins">${coins.map(c =>
        `<button type="button" class="wdm-ml-coin" data-coin="${c.k}">${esc(capCoin(c.k))} ${c.v}</button>`).join("")}</div>`
    : "";

  const footHtml = (isLoot && (rows.length || coins.length))
    ? `<div class="wdm-ml-foot"><button type="button" class="wdm-ml-takeall">${t("WITCHER.Chrome.MapLoot.Text.TakeAll", "Take all")}</button></div>`
    : "";
  return itemsHtml + coinsHtml + footHtml;
}

/* Same UI-scaling group as the token config popups: `data-wdm-scaled="1"` makes
 * the shared CSS apply `zoom: var(--wdm-popup-scale, …)`, which scales BOTH
 * layout and position. getBoundingClientRect + window.inner* are VISUAL pixels;
 * CSS `zoom` multiplies css_px → visual_px, so we divide the computed position
 * by the zoom var (identical to the inventory floating-container popup). */
const ZOOM_VAR = "var(--wdm-popup-scale, var(--wdm-chrome-bars-scale, 1))";
function positionPanel(el, token) {
  try {
    const c = token?.center ?? { x: token.x, y: token.y };
    const p = canvas?.stage?.toGlobal?.(new PIXI.Point(c.x, c.y));
    const rect = el.getBoundingClientRect();   // scaled footprint (attr already stamped)
    let left = (p?.x ?? window.innerWidth / 2) + 24;
    let top  = (p?.y ?? window.innerHeight / 2) - rect.height / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - rect.width - 8));
    top  = Math.max(8, Math.min(top, window.innerHeight - rect.height - 8));
    el.style.left = `calc(${Math.round(left)}px / ${ZOOM_VAR})`;
    el.style.top  = `calc(${Math.round(top)}px / ${ZOOM_VAR})`;
  } catch (_) { el.style.left = "50%"; el.style.top = "30%"; }
}

function closeTakeList() {
  if (_panelOutside) { document.removeEventListener("mousedown", _panelOutside, true); _panelOutside = null; }
  for (const [name, fn] of _panelHooks) { try { Hooks.off(name, fn); } catch (_) {} }
  _panelHooks = [];
  if (_panelEl) { try { _panelEl.remove(); } catch (_) {} _panelEl = null; }
  _panelTokenId = null;
  _panelTileId = null;
  _panelObjs = null;
}

/** Is a single loot object (token OR tile) still reachable by `me` — grabbable,
 *  adjacent, and in view? Used to decide whether an open loot window must close. */
function lootObjReachable(obj, me) {
  if (!obj || obj.destroyed || !me) return false;
  if (isTile(obj)) return tileIsLoot(obj) && isAdjacent(me, obj) && lootInView(obj);
  return !!grabbableFor(obj, me);
}

function closeTakeListIfOutOfReach() {
  if (!_panelEl) return;
  // Combined menu (immersive multi-item): close once NONE of its listed loot
  // objects are still in reach — i.e. the driving token stepped out of range.
  if (_panelObjs) {
    const me = playerToken();
    if (!me || !_panelObjs.some(o => lootObjReachable(o, me))) closeTakeList();
    return;
  }
  if (_panelTokenId) {
    const token = canvas?.tokens?.get?.(_panelTokenId);
    if (!token || !grabbableAndAdjacent(token)) closeTakeList();
    return;
  }
  if (_panelTileId) {
    const tile = canvas?.tiles?.get?.(_panelTileId);
    const me = playerToken();
    if (!tile || !tileIsLoot(tile) || !me || !isAdjacent(me, tile) || !lootInView(tile)) closeTakeList();
  }
}

function openTakeList(token) {
  const actor = token?.actor;
  if (!actor) return;
  const recipient = playerActor();   // the token you're driving receives the loot
  if (!recipient) {
    ui.notifications?.warn?.(t("WITCHER.Chrome.MapLoot.Notify.NoCharacter", "Assign / control a character before taking loot."));
    return;
  }
  ensurePanelStyle();
  closeTakeList();

  const el = document.createElement("div");
  el.id = "wdm-map-loot";
  el.className = "witcher-ttrpg-death-march";
  el.innerHTML = `
    <div class="wdm-ml-head">
      <span class="nm" title="${esc(actor.name)}">${esc(actor.name)}</span>
      <button type="button" class="wdm-ml-close" title="${t("WITCHER.Common.Close", "Close")}"><i class="fa-solid fa-xmark"></i></button>
    </div>
    <div class="wdm-ml-body">${renderPanelBody(actor)}</div>`;
  el.setAttribute("data-wdm-scaled", "1");   // join the token-config UI-scaling group
  document.body.appendChild(el);
  _panelEl = el;
  _panelTokenId = token.id;
  positionPanel(el, token);

  const rerender = () => {
    if (!_panelEl) return;
    const live = canvas?.tokens?.get?.(_panelTokenId)?.actor ?? actor;
    _panelEl.querySelector(".wdm-ml-body").innerHTML = renderPanelBody(live);
    positionPanel(_panelEl, canvas?.tokens?.get?.(_panelTokenId) ?? token);
  };

  // Taking off a CORPSE costs one Action in combat (a loot pile is free).
  const isCorpse = actor?.type !== "loot";
  el.addEventListener("click", async (ev) => {
    if (ev.target.closest(".wdm-ml-close")) { closeTakeList(); return; }
    const equipBtn = ev.target.closest(".wdm-ml-equip");
    if (equipBtn) {
      const weapon = actor.items?.get?.(equipBtn.dataset.itemId);
      if (!weapon) return;
      if (isCorpse && !canSpendCombatAction(recipient)) return;
      await takeAndEquip(actor, recipient, weapon);
      if (isCorpse) await chargeCombatAction(recipient, `Loot & equip: ${weapon.name}`);
      setTimeout(rerender, 150);
      return;
    }
    const takeBtn = ev.target.closest(".wdm-ml-take");
    if (takeBtn) {
      if (isCorpse && !canSpendCombatAction(recipient)) return;   // no action left → abort (warns)
      const itemName = actor.items?.get?.(takeBtn.dataset.itemId)?.name ?? "item";
      await emitGiftItem({ sourceActorUuid: actor.uuid, targetActorUuid: recipient.uuid, itemId: takeBtn.dataset.itemId, quantity: 1, fromUserId: game.user?.id ?? null });
      if (isCorpse) await chargeCombatAction(recipient, `Loot: ${itemName}`);
      setTimeout(rerender, 120);
      return;
    }
    const coinBtn = ev.target.closest(".wdm-ml-coin");
    if (coinBtn) {
      const coin = coinBtn.dataset.coin;
      const amt = Number(actor.system?.currency?.[coin]) || 0;
      if (amt <= 0) return;
      if (isCorpse && !canSpendCombatAction(recipient)) return;
      await emitTransferLootCurrency({ sourceActorUuid: actor.uuid, targetActorUuid: recipient.uuid, coin, quantity: amt, fromUserId: game.user?.id ?? null });
      if (isCorpse) await chargeCombatAction(recipient, `Loot: ${coin}`);
      setTimeout(rerender, 120);
      return;
    }
    if (ev.target.closest(".wdm-ml-takeall")) {
      await emitTakeAllLoot({ sourceActorUuid: actor.uuid, targetActorUuid: recipient.uuid, fromUserId: game.user?.id ?? null });
      setTimeout(rerender, 150);
      return;
    }
  });

  // Live-refresh as the pile changes (GM replicates the removal back). Only when
  // the change touches THIS source actor. Hooks are removed on close.
  const onItem = (doc) => { if ((doc?.parent?.id ?? doc?.id) === actor.id) rerender(); };
  const onActor = (doc) => { if (doc?.id === actor.id) rerender(); };
  for (const [name, fn] of [["updateItem", onItem], ["deleteItem", onItem], ["createItem", onItem], ["updateActor", onActor]]) {
    Hooks.on(name, fn); _panelHooks.push([name, fn]);
  }

  // Outside-click closes (deferred so the opening click doesn't instantly close).
  setTimeout(() => {
    _panelOutside = (ev) => { if (_panelEl && !_panelEl.contains(ev.target)) closeTakeList(); };
    document.addEventListener("mousedown", _panelOutside, true);
  }, 0);
}

/** Ground-item tile clicked → a single-item popup (icon + name + Take), matching
 *  the token loot panel. Take routes through `takeTile` (item → driving token,
 *  tile removed, one Action in combat) and closes the panel. */
function openTileTakeList(tile) {
  if (!tileIsLoot(tile)) return;
  const recipient = playerActor();
  if (!recipient) {
    ui.notifications?.warn?.(t("WITCHER.Chrome.MapLoot.Notify.NoCharacter", "Assign / control a character before taking loot."));
    return;
  }
  ensurePanelStyle();
  closeTakeList();

  const meta = tileLootMeta(tile);
  const canEquip = tileWeaponEquippable(tile, recipient);
  const el = document.createElement("div");
  el.id = "wdm-map-loot";
  el.className = "witcher-ttrpg-death-march";
  el.innerHTML = `
    <div class="wdm-ml-head">
      <span class="nm" title="${esc(meta.name)}">${esc(meta.name)}</span>
      <button type="button" class="wdm-ml-close" title="${t("WITCHER.Common.Close", "Close")}"><i class="fa-solid fa-xmark"></i></button>
    </div>
    <div class="wdm-ml-body"><ul><li data-tile="1">
      <img src="${esc(meta.img)}" alt="" draggable="false"/>
      <span class="nm" title="${esc(meta.name)}">${esc(meta.name)}</span>
      ${meta.qty > 1 ? `<span class="qty">×${meta.qty}</span>` : ""}
      ${canEquip ? `<button type="button" class="wdm-ml-equip" title="${t("WITCHER.Chrome.MapLoot.Text.EquipFreeHand", "Take & equip to a free hand")}"><i class="fa-solid fa-hand-fist"></i></button>` : ""}
      <button type="button" class="wdm-ml-take">${t("WITCHER.Chrome.LootDisplay.Text.Take", "Take")}</button>
    </li></ul></div>`;
  el.setAttribute("data-wdm-scaled", "1");   // join the token-config UI-scaling group
  document.body.appendChild(el);
  _panelEl = el;
  _panelTileId = tile.id;
  // Position by the tile's true (anchor-aware) visual center, not Foundry's
  // PlaceableObject#center which assumes a top-left origin.
  const r = tileVisualRect(tile);
  positionPanel(el, r ? { center: { x: r.cx, y: r.cy } } : tile);

  el.addEventListener("click", async (ev) => {
    if (ev.target.closest(".wdm-ml-close")) { closeTakeList(); return; }
    if (ev.target.closest(".wdm-ml-equip")) {
      const live = canvas?.tiles?.get?.(_panelTileId) ?? tile;
      if (!canSpendCombatAction(recipient)) return;   // no action left in combat → keep panel, warn
      closeTakeList();
      await takeTileAndEquip(live, recipient);
      return;
    }
    if (ev.target.closest(".wdm-ml-take")) {
      const live = canvas?.tiles?.get?.(_panelTileId) ?? tile;
      if (!canSpendCombatAction(recipient)) return;   // no action left in combat → keep panel, warn
      closeTakeList();
      await takeTile(live);
    }
  });

  // If the tile vanishes (taken elsewhere / deleted), drop the panel.
  const onTile = (doc) => { if (doc?.id === _panelTileId) closeTakeList(); };
  Hooks.on("deleteTile", onTile); _panelHooks.push(["deleteTile", onTile]);

  setTimeout(() => {
    _panelOutside = (ev) => { if (_panelEl && !_panelEl.contains(ev.target)) closeTakeList(); };
    document.addEventListener("mousedown", _panelOutside, true);
  }, 0);
}

/* ─────────────────────── carcass menu (P3) ─────────────────────── */

/** The world `remains` item created for this defeated monster (monster-remains.js
 *  links it by the monster's source UUID / actor UUID), or null. */
function findRemainsForToken(token) {
  const actor = token?.actor;
  if (!actor) return null;
  // Token mode: the carcass is embedded on the token's own actor.
  const embedded = (actor.items?.contents ?? actor.items ?? []).find(it => it?.type === "remains");
  if (embedded) return embedded;
  // Theater-of-mind fallback: a world remains item linked by monsterUuid.
  const uuid = actor.uuid;
  const source = actor._stats?.compendiumSource ?? actor.flags?.core?.sourceId ?? uuid;
  const wanted = new Set([uuid, source].filter(Boolean));
  const items = game.items?.contents ?? [];
  return items.find(it => it.type === "remains" && (
    wanted.has(it.system?.monsterUuid) || wanted.has(it.flags?.[SYSTEM_ID]?.monsterUuid)
  )) ?? null;
}

/** Non-people carcass: show the SAME action set as right-clicking the remains
 *  item in the sidebar (harvest / dissect / extract / …), rendered as our own
 *  themed menu — v14-safe (pre-filtered entries, no ContextMenu widget / no
 *  deprecated entry.condition). Actions route harvested output to the clicking
 *  player's character (runCarcassAction's actor arg). */
function openCarcassContextMenu(token) {
  const actor = playerActor();   // harvest/dissect output + skill checks come from the driven token
  if (!actor) { ui.notifications?.warn?.(t("WITCHER.Chrome.MapLoot.Notify.NoCharacter", "Assign / control a character first.")); return; }
  const remains = findRemainsForToken(token);
  if (!remains) { ui.notifications?.info?.(t("WITCHER.Chrome.MapLoot.Notify.NoCarcass", "This carcass has nothing to harvest.")); return; }
  const entries = buildItemActionEntries(() => remains, () => actor, "sidebar")
    .filter(e => { try { return e.condition ? e.condition(null) !== false : true; } catch (_) { return false; } });

  /* Whole-carcass grab: transfer the remains item itself to the looter (its
   * charges/config ride along via the item), removing it from the corpse. Costs
   * one Action in combat like any other corpse take. Prepended so it's always
   * the first option — available even when there are no harvest/dissect actions
   * (so the "nothing to harvest" bail below can't hide it). */
  const srcUuid = remains.actor?.uuid ?? remains.parent?.uuid ?? token.actor?.uuid ?? null;
  if (srcUuid) {
    entries.unshift({
      name: t("WITCHER.Chrome.MapLoot.Text.TakeCarcass", "Take carcass"),
      icon: '<i class="fa-solid fa-hand-holding-medical"></i>',
      callback: async () => {
        const inCombat = (() => { try { return isActorInActiveCombat(actor); } catch (_) { return false; } })();
        if (inCombat && !canSpendCombatAction(actor)) return;   // no action left → warns + abort
        const nm = remains.name;
        await emitGiftItem({ sourceActorUuid: srcUuid, targetActorUuid: actor.uuid, itemId: remains.id, quantity: 1, fromUserId: game.user?.id ?? null });
        if (inCombat) await chargeCombatAction(actor, `Take carcass: ${nm}`);
        // Took the whole body → remove the corpse token from the map (GM-routed;
        // works for players too). Idempotent if something else already deleted it.
        try { emitDeleteCorpseToken({ sceneId: token.document?.parent?.id ?? canvas?.scene?.id, tokenId: token.id }); } catch (_) {}
      }
    });
  }

  if (!entries.length) { ui.notifications?.info?.(t("WITCHER.Chrome.MapLoot.Notify.NoCarcass", "This carcass has nothing to harvest.")); return; }

  // Coin carried by the monster itself is looted here (the harvest/dissect menu
  // is the only click path to a monster corpse, so without this its currency is
  // unreachable). Same transfer + per-type-costs-an-Action rule as openTakeList.
  const cur = token.actor?.system?.currency ?? {};
  const cap = (k) => String(k).charAt(0).toUpperCase() + String(k).slice(1);
  const coins = COINS.map(k => ({ k, v: Number(cur[k]) || 0 })).filter(c => c.v > 0);
  const coinsHtml = coins.length
    ? `<div class="wdm-ml-coins">${coins.map(c => `<button type="button" class="wdm-ml-coin" data-coin="${esc(c.k)}">${esc(cap(c.k))} ${c.v}</button>`).join("")}</div>`
    : "";

  ensurePanelStyle();
  closeTakeList();
  const el = document.createElement("div");
  el.id = "wdm-map-loot";
  el.className = "witcher-ttrpg-death-march";
  el.innerHTML = `
    <div class="wdm-ml-head">
      <span class="nm" title="${esc(remains.name)}">${esc(remains.name)}</span>
      <button type="button" class="wdm-ml-close" title="${t("WITCHER.Common.Close", "Close")}"><i class="fa-solid fa-xmark"></i></button>
    </div>
    <div class="wdm-ml-body"><div class="wdm-ml-actions">${entries.map((e, i) =>
      `<button type="button" class="wdm-ml-action" data-idx="${i}">${e.icon ?? ""}<span class="nm">${esc(e.name)}</span></button>`).join("")}</div>${coinsHtml}</div>`;
  el.setAttribute("data-wdm-scaled", "1");   // join the token-config UI-scaling group
  document.body.appendChild(el);
  _panelEl = el;
  _panelTokenId = token.id;
  positionPanel(el, token);

  el.addEventListener("click", async (ev) => {
    if (ev.target.closest(".wdm-ml-close")) { closeTakeList(); return; }
    const coinBtn = ev.target.closest(".wdm-ml-coin");
    if (coinBtn) {
      const coin = coinBtn.dataset.coin;
      const amt = Number(token.actor?.system?.currency?.[coin]) || 0;
      if (amt <= 0) { coinBtn.remove(); return; }
      const inCombat = (() => { try { return isActorInActiveCombat(actor); } catch (_) { return false; } })();
      if (inCombat && !canSpendCombatAction(actor)) return;   // no action left → warns + abort
      await emitTransferLootCurrency({ sourceActorUuid: token.actor.uuid, targetActorUuid: actor.uuid, coin, quantity: amt, fromUserId: game.user?.id ?? null });
      if (inCombat) await chargeCombatAction(actor, `Loot: ${coin}`);
      coinBtn.remove();   // taken in full — keep the menu open for the rest
      return;
    }
    const btn = ev.target.closest(".wdm-ml-action");
    if (!btn) return;
    const entry = entries[Number(btn.dataset.idx)];
    closeTakeList();
    try { entry?.callback?.(null); } catch (err) { console.warn(`${SYSTEM_ID} | carcass action failed`, err); }
  });
  setTimeout(() => {
    _panelOutside = (ev) => { if (_panelEl && !_panelEl.contains(ev.target)) closeTakeList(); };
    document.addEventListener("mousedown", _panelOutside, true);
  }, 0);
}

/* ─────── combined loot for the faced cell (immersive [E]) ─────── */

/** Flatten every takeable thing across all loot objects in the faced cell into
 *  one list. Row kinds: "item" (Take + optional Equip), "coin" (Take), "action"
 *  (carcass harvest/dissect/take-carcass — launches its own flow, closes menu).
 *  Reuses the exact take/equip/currency helpers so peace-vs-combat action costs
 *  are identical to the click windows. */
function collectCombinedRows(objects, recipient) {
  const rows = [];
  const cap = (k) => String(k).charAt(0).toUpperCase() + String(k).slice(1);
  const coinRow = (srcActor, coin, v, isCorpse) => ({
    kind: "coin", name: `${cap(coin)} ${v}`,
    take: async () => {
      if (isCorpse && !canSpendCombatAction(recipient)) return;
      await emitTransferLootCurrency({ sourceActorUuid: srcActor.uuid, targetActorUuid: recipient.uuid, coin, quantity: v, fromUserId: game.user?.id ?? null });
      if (isCorpse) await chargeCombatAction(recipient, `Loot: ${coin}`);
    }
  });

  for (const obj of objects) {
    if (!obj || obj.destroyed) continue;

    if (isTile(obj)) {
      if (!tileIsLoot(obj)) continue;
      const meta = tileLootMeta(obj);
      const tileId = obj.id;
      const row = { kind: "item", img: meta.img, name: meta.name, qty: meta.qty,
        take: () => takeTile(canvas?.tiles?.get?.(tileId) ?? obj) };
      if (tileWeaponEquippable(obj, recipient)) row.equip = () => takeTileAndEquip(canvas?.tiles?.get?.(tileId) ?? obj, recipient);
      rows.push(row);
      continue;
    }

    const actor = obj.actor;
    if (!actor) continue;
    const kind = grabbableKind(obj);

    if (kind === "monster" || kind === "monster-people") {
      const remains = findRemainsForToken(obj);
      if (remains) {
        const srcUuid = remains.actor?.uuid ?? remains.parent?.uuid ?? actor.uuid ?? null;
        const tok = obj;
        if (srcUuid) rows.push({ kind: "action", img: remains.img, name: `${t("WITCHER.Chrome.MapLoot.Text.TakeCarcass", "Take carcass")}: ${remains.name}`,
          run: async () => {
            const inCombat = (() => { try { return isActorInActiveCombat(recipient); } catch (_) { return false; } })();
            if (inCombat && !canSpendCombatAction(recipient)) return;
            await emitGiftItem({ sourceActorUuid: srcUuid, targetActorUuid: recipient.uuid, itemId: remains.id, quantity: 1, fromUserId: game.user?.id ?? null });
            if (inCombat) await chargeCombatAction(recipient, `Take carcass: ${remains.name}`);
            try { emitDeleteCorpseToken({ sceneId: tok.document?.parent?.id ?? canvas?.scene?.id, tokenId: tok.id }); } catch (_) {}
          } });
        const acts = buildItemActionEntries(() => remains, () => recipient, "sidebar")
          .filter(e => { try { return e.condition ? e.condition(null) !== false : true; } catch (_) { return false; } });
        for (const a of acts) rows.push({ kind: "action", icon: a.icon, name: a.name, run: () => { try { a.callback?.(null); } catch (_) {} } });
      }
      const mc = actor.system?.currency ?? {};
      for (const c of COINS) { const v = Number(mc[c]) || 0; if (v > 0) rows.push(coinRow(actor, c, v, true)); }
      continue;
    }

    // loot pile / character corpse → item + currency rows
    const isCorpse = actor.type !== "loot";
    for (const r of lootRows(actor, isCorpse)) {
      const it = r.item;
      const itemId = it.id, nm = it.name;
      const row = { kind: "item", img: it.img, name: nm, qty: Math.max(1, Number(it.system?.quantity) || 1),
        take: async () => {
          if (isCorpse && !canSpendCombatAction(recipient)) return;
          await emitGiftItem({ sourceActorUuid: actor.uuid, targetActorUuid: recipient.uuid, itemId, quantity: 1, fromUserId: game.user?.id ?? null });
          if (isCorpse) await chargeCombatAction(recipient, `Loot: ${nm}`);
        } };
      if (it.type === "weapon" && canEquipWeapon(recipient, it)) row.equip = async () => {
        if (isCorpse && !canSpendCombatAction(recipient)) return;
        await takeAndEquip(actor, recipient, it);
        if (isCorpse) await chargeCombatAction(recipient, `Loot & equip: ${nm}`);
      };
      rows.push(row);
    }
    const ac = actor.system?.currency ?? {};
    for (const c of COINS) { const v = Number(ac[c]) || 0; if (v > 0) rows.push(coinRow(actor, c, v, isCorpse)); }
  }
  return rows;
}

/** ONE flat loot menu for every source in the faced cell (immersive [E]). */
function openCombinedLoot(objects) {
  const recipient = playerActor();
  if (!recipient) { ui.notifications?.warn?.(t("WITCHER.Chrome.MapLoot.Notify.NoCharacter", "Assign / control a character before taking loot.")); return; }
  const live = () => objects.filter(o => o && !o.destroyed);
  let rows = collectCombinedRows(live(), recipient);
  if (!rows.length) { ui.notifications?.info?.(t("WITCHER.Chrome.MapLoot.Text.Empty", "Nothing left to take.")); return; }

  ensurePanelStyle();
  closeTakeList();
  const takeLabel = t("WITCHER.Chrome.LootDisplay.Text.Take", "Take");
  const equipTitle = t("WITCHER.Chrome.MapLoot.Text.EquipFreeHand", "Take & equip to a free hand");
  const rowHtml = (r, i) => {
    if (r.kind === "action") {
      return `<li data-idx="${i}" class="wdm-ml-actionrow"><button type="button" class="wdm-ml-action" data-idx="${i}">${r.icon ?? (r.img ? `<img src="${esc(r.img)}" alt="" draggable="false"/>` : "")}<span class="nm" title="${esc(r.name)}">${esc(r.name)}</span></button></li>`;
    }
    return `<li data-idx="${i}">
      ${r.img ? `<img src="${esc(r.img)}" alt="" draggable="false"/>` : ""}
      <span class="nm" title="${esc(r.name)}">${esc(r.name)}</span>
      ${r.qty > 1 ? `<span class="qty">×${r.qty}</span>` : ""}
      ${r.equip ? `<button type="button" class="wdm-ml-equip" data-idx="${i}" title="${equipTitle}"><i class="fa-solid fa-hand-fist"></i></button>` : ""}
      <button type="button" class="wdm-ml-take" data-idx="${i}">${takeLabel}</button>
    </li>`;
  };
  const body = (rs) => `<ul>${rs.map(rowHtml).join("")}</ul>`;

  const el = document.createElement("div");
  el.id = "wdm-map-loot";
  el.className = "witcher-ttrpg-death-march";
  el.innerHTML = `
    <div class="wdm-ml-head">
      <span class="nm">${esc(t("WITCHER.Chrome.MapLoot.Text.Loot", "Loot"))}</span>
      <button type="button" class="wdm-ml-close" title="${t("WITCHER.Common.Close", "Close")}"><i class="fa-solid fa-xmark"></i></button>
    </div>
    <div class="wdm-ml-body">${body(rows)}</div>`;
  el.setAttribute("data-wdm-scaled", "1");
  document.body.appendChild(el);
  _panelEl = el; _panelTokenId = null; _panelTileId = null; _panelObjs = objects.slice();
  const c0 = _facedWorldPt ?? objCenter(live()[0]);
  positionPanel(el, c0 ? { center: c0 } : (objects[0] ?? null));

  const rerender = () => {
    if (_panelEl !== el) return;
    rows = collectCombinedRows(live(), recipient);
    if (!rows.length) { closeTakeList(); return; }
    const b = el.querySelector(".wdm-ml-body");
    if (b) b.innerHTML = body(rows);
  };

  el.addEventListener("click", async (ev) => {
    if (ev.target.closest(".wdm-ml-close")) { closeTakeList(); return; }
    const eqBtn = ev.target.closest(".wdm-ml-equip");
    if (eqBtn) { const r = rows[Number(eqBtn.dataset.idx)]; if (r?.equip) { try { await r.equip(); } catch (_) {} setTimeout(rerender, 140); } return; }
    const tkBtn = ev.target.closest(".wdm-ml-take");
    if (tkBtn) { const r = rows[Number(tkBtn.dataset.idx)]; if (r?.take) { try { await r.take(); } catch (_) {} setTimeout(rerender, 140); } return; }
    const acBtn = ev.target.closest(".wdm-ml-action");
    if (acBtn) { const r = rows[Number(acBtn.dataset.idx)]; closeTakeList(); if (r?.run) { try { await r.run(); } catch (_) {} } return; }
  });

  // Live-refresh if a faced source changes remotely (GM replicates removals).
  const srcIds = new Set(live().map(o => (o.actor?.id ?? o.id)));
  const onChange = (doc) => { const id = doc?.parent?.id ?? doc?.id; if (srcIds.has(id)) rerender(); };
  for (const name of ["updateItem", "deleteItem", "createItem", "updateActor"]) { Hooks.on(name, onChange); _panelHooks.push([name, onChange]); }
  const onTileGone = (doc) => { if (srcIds.has(doc?.id)) rerender(); };
  Hooks.on("deleteTile", onTileGone); _panelHooks.push(["deleteTile", onTileGone]);

  setTimeout(() => {
    _panelOutside = (ev) => { if (_panelEl && !_panelEl.contains(ev.target)) closeTakeList(); };
    document.addEventListener("mousedown", _panelOutside, true);
  }, 0);
}

/** Resolve a dropped Item (world sidebar OR compendium) and, if it's an eligible
 *  physical item the user owns, spawn a loot tile from it. Rejects actor-embedded
 *  (inventory) items — those must not become tiles. Async because compendium
 *  items must be loaded via fromUuid. `x`/`y` are world coordinates. */
async function dropDirectoryItemAsTile(data) {
  let item = null;
  try { item = await fromUuid(data.uuid); } catch (_) { item = null; }
  if (!item || item.documentName !== "Item") return;
  if (item.isEmbedded || item.actor || item.parent?.documentName === "Actor") return;   // no inventory items
  if (LOOT_EXCLUDE.has(item.type) || item.type === "container") return;
  if (!item.isOwner) return;
  const scene = canvas?.scene;
  if (!scene) return;
  emitDropWorldItemAsTile({ itemUuid: item.uuid, sceneId: scene.id, x: Number(data.x) || 0, y: Number(data.y) || 0 });
}

/* ───────────────────────── install ───────────────────────── */

export function installMapLoot() {
  try { patchTokenClick(); } catch (err) { console.warn(`${SYSTEM_ID} | map-loot _onClickLeft patch failed`, err); }
  try { patchMeshTint(); } catch (err) { console.warn(`${SYSTEM_ID} | map-loot _refreshMesh tint patch failed`, err); }
  // Immersive mode: [E] loots the faced cell; the prompt tracks the camera as it
  // pans; toggling immersive (or its setting) re-sweeps so tint↔halo swaps.
  document.addEventListener("keydown", onLootKeydown, true);
  Hooks.on("canvasPan", onLootCanvasPan);
  Hooks.on("updateSetting", (setting) => { if (String(setting?.key ?? "").includes("immersiveTokenCamera")) scheduleRefresh(); });
  // Scene rebuild destroys canvas.interface (and our halo layer); drop stale
  // sprite refs so they're re-created fresh on the new canvas.
  Hooks.on("canvasReady", () => { try { hideLootPrompt(); wireMapLootPointer(); } catch (_) {} invalidateVisCache(); scheduleRefresh(); });
  Hooks.on("canvasTearDown", () => { try { hideLootPrompt(); } catch (_) {} });
  // Loot tiles glow + become grabbable on create/update/redraw.
  Hooks.on("createTile", scheduleRefresh);
  Hooks.on("updateTile", scheduleRefresh);
  Hooks.on("deleteTile", scheduleRefresh);
  Hooks.on("drawTile", (tile) => { try { tile._wdmMapLootHLSig = null; } catch (_) {} scheduleRefresh(); });
  // PERFORMANCE: do NO per-token detection on the refresh hot path. A loot cue
  // can only change when a token MOVES (position/elevation → adjacency) or TURNS
  // (rotation → faced cell), so gate on exactly those render flags and let the
  // RAF-debounced sweep do the one detection pass. Hover/selection/vision/mesh
  // refreshes (the bulk, incl. the immersive camera's per-frame token touches)
  // are ignored. The tint pins itself via the _refreshMesh wrap; the halo lives
  // in a static world-space layer — neither needs a per-refresh re-apply.
  Hooks.on("refreshToken", (token, flags) => {
    // Ignore refreshes that can't move a token (hover, selection, vision, mesh —
    // the bulk, incl. the immersive camera's per-frame touches).
    if (flags && !(flags.refreshPosition || flags.refreshRotation || flags.refreshElevation)) return;
    // A loot cue can only change when a token crosses into a NEW CELL, turns to a
    // new 8-way FACING, or changes ELEVATION — never on the intermediate frames of
    // a smooth move / immersive follow. Cache that quantized signature per token
    // and skip the sweep while it's unchanged: standing or animating NEXT to loot
    // no longer re-runs the per-adjacent-loot visibility test (testVisibility)
    // every frame. The loot state is computed once per cell and just revealed /
    // hidden on the actual transition. (updateToken still fires an ungated sweep
    // at the resting position, so the final state is always exact.)
    try {
      const c = cellOf(token?.center);
      const d = facingDelta(token);
      const sig = c ? `${c.i},${c.j},${d.di},${d.dj},${Number(token?.document?.elevation) || 0}` : null;
      if (sig !== null && token._wdmLootCellSig === sig) return;   // same cell+facing → cached, no re-sweep
      token._wdmLootCellSig = sig;
    } catch (_) { /* on any error, fall through and sweep */ }
    // Only the player's own move (or a loot token entering/leaving reach) can
    // change the glow — skip the all-tiles sweep when ANOTHER creature moves.
    if (!isLootRelevantToken(token)) return;
    scheduleRefresh();
  });
  Hooks.on("drawToken", (token) => { try { token._wdmMapLootHLSig = null; token._wdmLootCellSig = null; } catch (_) {} scheduleRefresh(); });
  Hooks.on("controlToken", scheduleRefresh);
  // updateToken is the ONLY reliable catch for a facing change: in immersive mode
  // the token's rotation is LOCKED, so Token#_onAnimationUpdate suppresses the
  // `refreshRotation` render flag (token.mjs:2425) — the refreshToken gate never
  // sees the turn. Re-sweep now AND once the ~400ms turn animation settles, so
  // the faced cell / [E] target lands on the final facing even if document
  // rotation is still mid-interpolation on the immediate pass.
  Hooks.on("updateToken", (_doc, changes) => {
    // Same relevance gate as refreshToken: a resting move by another creature
    // doesn't change what the player can reach or see.
    const tok = _doc?.object ?? canvas?.tokens?.get?.(_doc?.id);
    if (!isLootRelevantToken(tok)) return;
    scheduleRefresh();
    if (changes && "rotation" in changes) setTimeout(scheduleRefresh, 420);
  });
  Hooks.on("createToken", scheduleRefresh);
  Hooks.on("deleteToken", (t) => { if (t?.id === _panelTokenId) closeTakeList(); scheduleRefresh(); });
  // Door open/close + wall edits → re-sweep so the [E] Open/Close prompt flips
  // and Foundry's redrawn door icons get re-hidden while immersive.
  // Wall edits (incl. a door opening/closing) change what's in view → drop the
  // cached visibility so the next sweep re-tests.
  Hooks.on("updateWall", () => { invalidateVisCache(); scheduleRefresh(); });
  Hooks.on("createWall", () => { invalidateVisCache(); scheduleRefresh(); });
  Hooks.on("deleteWall", () => { invalidateVisCache(); scheduleRefresh(); });
  // Defeat/undefeat + dead status flips a token's grabbable state.
  Hooks.on("createActiveEffect", (e) => { if (e?.statuses?.has?.("dead")) scheduleRefresh(); });
  Hooks.on("deleteActiveEffect", (e) => { if (e?.statuses?.has?.("dead")) scheduleRefresh(); });
  Hooks.on("updateCombatant", scheduleRefresh);
  // Combat start/end flips the loot glow (OOC-gated) → always re-sweep.
  Hooks.on("combatStart", scheduleRefresh);
  Hooks.on("deleteCombat", scheduleRefresh);
  // A turn transition can redraw Foundry's door controls, so re-sweep to
  // re-hide them — but ONLY camera-on (door-hiding is a camera feature). The
  // loot glow itself doesn't change on a turn boundary, so camera-OFF this was
  // a wasted full all-tiles testVisibility sweep every turn — a notable FPS
  // drop at turn start (independent of whether the camera is on). A controlled-
  // token change (e.g. GM auto-select of the active token) is already caught by
  // the controlToken hook above, so the glow stays correct either way.
  Hooks.on("combatTurnChange", () => {
    try { if (immersiveCameraOn?.()) scheduleRefresh(); } catch (_) { /* be safe */ }
  });

  // Drag a WORLD item (Items sidebar) onto the map → a small (0.5-grid) loot
  // TILE with the item's icon appears at the drop point. The world item is a
  // reusable template, so it's snapshotted, NOT deleted. GM-routed.
  //
  // WORLD-BAR ONLY, by design: actor-inventory items and chrome-inventory items
  // must NOT create tiles. So this uses ONLY Foundry's `dropCanvasData` hook —
  // which fires for drags from the Items sidebar onto the real canvas (#board),
  // with `data.x/y` already in world space. Any item that turns out to be
  // embedded in an actor is rejected outright. (No chrome-overlay listener: that
  // surface is exactly the case we now refuse.)
  Hooks.on("dropCanvasData", (_canvas, data) => {
    try {
      if (!data || data.type !== "Item" || !data.uuid) return;   // not ours → let Foundry handle
      // Resolve + emit asynchronously: compendium items aren't reliably available
      // via fromUuidSync, so we always use async fromUuid (works for world AND
      // compendium sources). data.x/y are already world coords (Board#_onDrop).
      dropDirectoryItemAsTile(data);
      return false;   // we own Item drops on the canvas
    } catch (_) { /* non-fatal */ }
  });

  // Tile Config → "This is Loot" toggle + an item drop slot (GM authoring).
  Hooks.on("renderTileConfig", (app, el) => { try { injectTileLootConfig(app, el); } catch (e) { console.warn(`${SYSTEM_ID} | tile loot config inject failed`, e); } });
}

/* Single canvas-stage hit-test for ALL map-loot clicks (grabbable tokens AND
 * loot tiles). This is the channel that works for PLAYERS — the same one the
 * tactical grid uses — unlike a Token#_onClickLeft patch which only fires for
 * the token's owner. A left pointerdown over a grabbable, adjacent token/tile
 * runs its loot action and is consumed (no pan / ping / deselect); every other
 * click passes straight through. Re-wired per scene (stage rebuilt on ready). */
function pointInBounds(pos, b) { return b && pos.x >= b.x1 && pos.x <= b.x2 && pos.y >= b.y1 && pos.y <= b.y2; }

function wireMapLootPointer() {
  const stage = canvas?.stage;
  if (!stage || stage._wdmMapLootWired) return;
  stage._wdmMapLootWired = true;
  stage.on("pointerdown", (ev) => {
    try {
      if ((ev?.button ?? 0) !== 0) return;   // left only (v14 FederatedPointerEvent)
      if (lootInteractionBlocked()) return;  // movement/targeting overlay owns the click
      const me = playerToken();
      if (!me) return;
      if (immersiveActive(me)) return;       // immersive: looting is E-only, not click
      let pos = null;
      try { pos = ev.getLocalPosition?.(stage) ?? (ev.global ? stage.toLocal(ev.global) : null); } catch (_) { pos = null; }
      if (!pos) return;
      const consume = () => {
        try { ev.stopPropagation?.(); } catch (_) {}
        try { ev.stopImmediatePropagation?.(); } catch (_) {}
        try { ev.preventDefault?.(); } catch (_) {}
        cancelCanvasPing();   // kill any armed board long-press → no ping
      };
      // Grabbable TOKENS under the cursor, adjacent. The Token#_onClickLeft patch
      // handles a token only when it will actually fire there — i.e. the token is
      // interactable AND the user can control it (clickLeft is gated by
      // _canControl). Skip exactly those; everything else grabbable (loot the
      // player can't control, or non-interactable tokens) is handled here, where
      // the bubbled pointerdown still reaches us.
      for (const token of (canvas?.tokens?.placeables ?? [])) {
        if (token.isInteractable && token._canControl?.(game.user)) continue;
        const kind = grabbableFor(token, me);
        if (!kind || !pointInBounds(pos, placeableBounds(token))) continue;
        handleMapLootClick(token, kind);
        consume();
        return;
      }
      // Loot TILES under the cursor, adjacent → open the take popup.
      for (const tile of (canvas?.tiles?.placeables ?? [])) {
        if (!tileIsLoot(tile) || !pointInBounds(pos, placeableBounds(tile)) || !isAdjacent(me, tile) || !lootInView(tile)) continue;
        openTileTakeList(tile);
        consume();
        return;
      }
    } catch (_) { /* non-fatal */ }
  });
}

/* ─────────────────── Tile Config: "This is Loot" + item slot ─────────────────── */

function injectTileLootConfig(app, el) {
  // v13 render hook passes an HTMLElement; legacy passes jQuery.
  const root = (el instanceof HTMLElement) ? el : (el?.[0] ?? app?.element?.[0] ?? app?.element ?? null);
  const form = root?.matches?.("form") ? root : root?.querySelector?.("form") ?? root;
  if (!form || form.querySelector?.(".wdm-tile-loot")) return;
  const doc = app?.document ?? app?.object ?? null;
  const f = doc?.flags?.[SYSTEM_ID] ?? {};
  const uuid = f.lootUuid ?? "";
  let itemName = f.lootName ?? "";
  if (uuid) { try { itemName = fromUuidSync(uuid)?.name ?? itemName; } catch (_) {} }

  if (!document.getElementById("wdm-tile-loot-style")) {
    const st = document.createElement("style");
    st.id = "wdm-tile-loot-style";
    st.textContent = `
      .wdm-tile-loot-slot { display:flex; align-items:center; gap:0.4rem; min-height:1.9rem; padding:0.25rem 0.5rem;
        border:1px dashed var(--wdm-amber-dim, #6e5224); border-radius:3px; cursor:copy; }
      .wdm-tile-loot-slot.is-set { border-style:solid; }
      .wdm-tile-loot-slot .wdm-tile-loot-name { flex:1 1 auto; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .wdm-tile-loot-clear { cursor:pointer; opacity:0.6; background:none; border:0; color:inherit; }
      .wdm-tile-loot-clear:hover { opacity:1; }`;
    document.head.appendChild(st);
  }

  const group = document.createElement("fieldset");
  group.className = "wdm-tile-loot";
  group.innerHTML = `
    <legend>${t("WITCHER.Chrome.MapLoot.Config.Legend", "Loot")}</legend>
    <div class="form-group">
      <label>${t("WITCHER.Chrome.MapLoot.Config.IsLoot", "This is Loot")}</label>
      <input type="checkbox" name="flags.${SYSTEM_ID}.isLoot" ${f.isLoot ? "checked" : ""}/>
    </div>
    <div class="form-group">
      <label>${t("WITCHER.Chrome.MapLoot.Config.Item", "Item")}</label>
      <div class="form-fields">
        <div class="wdm-tile-loot-slot ${uuid || itemName ? "is-set" : ""}" title="${t("WITCHER.Chrome.MapLoot.Config.Drop", "Drag an item here")}">
          <span class="wdm-tile-loot-name">${esc(itemName || t("WITCHER.Chrome.MapLoot.Config.None", "— drag an item here —"))}</span>
          <button type="button" class="wdm-tile-loot-clear" title="${t("WITCHER.Common.Clear", "Clear")}"><i class="fa-solid fa-xmark"></i></button>
        </div>
        <input type="hidden" name="flags.${SYSTEM_ID}.lootUuid" value="${esc(uuid)}"/>
      </div>
      <p class="notes">${t("WITCHER.Chrome.MapLoot.Config.Note", "Drops the item onto whoever picks up this tile. The tile image is pre-filled with the item icon — change it above if you like.")}</p>
    </div>`;

  // Place just before the form's submit footer if there is one.
  const footer = form.querySelector(".form-footer, footer, .sheet-footer");
  if (footer) footer.before(group); else form.appendChild(group);

  const slot = group.querySelector(".wdm-tile-loot-slot");
  const nameEl = group.querySelector(".wdm-tile-loot-name");
  const hidden = group.querySelector(`input[name="flags.${SYSTEM_ID}.lootUuid"]`);
  const checkbox = group.querySelector(`input[name="flags.${SYSTEM_ID}.isLoot"]`);
  const setImg = (src) => {
    if (!src) return;
    const img = form.querySelector('[name="texture.src"]');
    const input = img?.tagName === "INPUT" ? img : img?.querySelector?.("input");
    if (input) input.value = src;
  };

  slot?.addEventListener("dragover", (ev) => ev.preventDefault());
  slot?.addEventListener("drop", async (ev) => {
    ev.preventDefault();
    let data = null;
    try { data = JSON.parse(ev.dataTransfer.getData("text/plain") || ev.dataTransfer.getData("application/json")); } catch (_) { data = null; }
    if (!data || data.type !== "Item" || !data.uuid) return;
    let item = null; try { item = await fromUuid(data.uuid); } catch (_) { item = null; }
    if (!item) return;
    hidden.value = data.uuid;
    nameEl.textContent = item.name;
    slot.classList.add("is-set");
    if (checkbox) checkbox.checked = true;
    setImg(item.img);
  });
  group.querySelector(".wdm-tile-loot-clear")?.addEventListener("click", () => {
    hidden.value = "";
    nameEl.textContent = t("WITCHER.Chrome.MapLoot.Config.None", "— drag an item here —");
    slot.classList.remove("is-set");
  });
}
