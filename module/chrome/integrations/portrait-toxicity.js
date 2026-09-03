/**
 * Variable portrait integration. Portrait swaps by toxicity tier + condition.
 * Storage: `actor.system.variablePortrait`. A one-shot migration lifts the
 * legacy 6-tier×trance flag slots into the new shape, and `padTiers` widens
 * a saved 7-tier array to the current 8-tier layout.
 */

import { rasterizePortraitCrop, PORTRAIT_CROP_FLAG } from "../../applications/ringPortraitCropper.mjs";

import { t, tFormat } from "../lib/i18n.js";
const MODULE_ID = "witcher-ttrpg-death-march";

/* Upper bound (inclusive) of each tier, as a fraction of toxicity.max. Tier i
 * applies when value/max ≤ TIER_BOUNDS[i]; the final tier is everything above
 * the last bound. 8 tiers: FOUR quarters of max (0-25 / 25-50 / 50-75 /
 * 75-100 %) then FOUR quarters over max (100-125 / 125-150 / 150-175 / >175
 * %). Overdose land: the actor can visibly deteriorate past the pool cap. */
const TIER_BOUNDS = [0.25, 0.50, 0.75, 1.00, 1.25, 1.50, 1.75];
const TIER_COUNT  = TIER_BOUNDS.length + 1; // 8
const TIER_NAMES  = ["Q1", "Q2", "Q3", "Q4", "OD1", "OD2", "OD3", "OD4"];

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

/* Pad a stored tier array to the current TIER_COUNT. The band count grew
 * from 7 to 8 when the sub-25% band was carved off the old 0-50% tier 0.
 * A 7-entry save maps to:
 *   new[0]  = old[0]      // 0-25% inherits old 0-50%'s image
 *   new[1]  = old[0]      // 26-50% ditto (image behaviour preserved)
 *   new[2..] = old[1..]   // higher bands slide right by one
 * So a GM's existing "Normal" portrait stays visible across the whole
 * 0-50% range they authored it for, and the freshly-carved Trace band
 * gets its own slot they can override without losing the old image. */
function padTiers(arr) {
  if (!Array.isArray(arr)) return new Array(TIER_COUNT).fill("");
  if (arr.length === TIER_COUNT) return arr.slice();
  if (arr.length === TIER_COUNT - 1) {
    const out = new Array(TIER_COUNT).fill("");
    out[0] = arr[0] ?? "";
    out[1] = arr[0] ?? "";
    for (let i = 1; i < arr.length; i++) out[i + 1] = arr[i] ?? "";
    return out;
  }
  const out = new Array(TIER_COUNT).fill("");
  for (let i = 0; i < Math.min(arr.length, TIER_COUNT); i++) out[i] = arr[i] ?? "";
  return out;
}

function getConfig(actor) {
  const cfg = actor.system?.variablePortrait ?? {};
  const base = padTiers(cfg.base);
  const conditions = Array.isArray(cfg.conditions)
    ? cfg.conditions.map(c => ({
        name:    c?.name ?? "",
        matches: normalizeMatches(c),
        tiers:   padTiers(c?.tiers)
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

/* Whether a single match-value is currently satisfied by the actor's
 * ACTIVE effects. "Active" = created directly on the actor (potion drunk,
 * spell cast, GM-authored AE) OR transferred from an item with
 * `transfer:true` (race passives, worn oil buffs). Effects sitting on an
 * inventory item with `transfer:false` do NOT count — so an unopened
 * Trance potion in the pack doesn't false-positive a "trance" match, but
 * drinking it (or applying an oil that transfers) does.
 *
 * `actor.allApplicableEffects()` (Foundry v14) yields exactly that set;
 * fall back to `appliedEffects` / `effects` for older Foundry builds.
 * `actor.statuses` aggregates from those same applied effects, so it's
 * the right place to look for status-id matches (`"drunk-3"`). */
function iterAppliedEffects(actor) {
  if (typeof actor?.allApplicableEffects === "function") {
    return actor.allApplicableEffects();
  }
  return actor?.appliedEffects ?? actor?.effects ?? [];
}

/* Sources a match row can target. `auto` preserves the pre-per-source
 * behavior (statuses + AE names + AE statuses) as the safe default for legacy
 * rows and for authors who want a broad search. The named sources scope the
 * match to one specific surface — fixing the "Cat school race name flags the
 * `cat` match" false-positive class. `path` reads any Foundry data path via
 * getProperty and does a case-insensitive substring test on the string form. */
export const MATCH_SOURCES = () => [
  { value: "auto",       label: t("WITCHER.Chrome.PortraitToxicity.Dialog.Button.AnyAuto", "Any (auto)") },
  { value: "status",     label: t("WITCHER.Chrome.PortraitToxicity.Dialog.Button.StatusID", "Status ID") },
  { value: "effect",     label: t("WITCHER.Chrome.PortraitToxicity.Dialog.Button.ActiveEffectName", "Active Effect name") },
  { value: "item",       label: t("WITCHER.Chrome.PortraitToxicity.Dialog.Button.ItemName", "Item name") },
  { value: "race",       label: t("WITCHER.Chrome.PortraitToxicity.Dialog.Button.RaceName", "Race name") },
  { value: "profession", label: t("WITCHER.Chrome.PortraitToxicity.Dialog.Button.ProfessionName", "Profession name") },
  { value: "path",       label: t("WITCHER.Chrome.PortraitToxicity.Dialog.Button.DataPath", "Data path") }
];

/* How the search term compares against a candidate string. `substring` is the
 * default (legacy behavior — case-insensitive `includes`); `exact` requires
 * the whole candidate to equal the term; `regex` treats the term as a JS
 * RegExp source (case-insensitive) so authors can write e.g. `^cat$` for a
 * strict match, `cat\b` for a word-boundary match, `^cat( |$)` etc. `regex`
 * is silently invalid → returns false (no throw into the render pipeline). */
export const MATCH_MODES = Object.freeze([
  { value: "substring", label: "contains" },
  { value: "exact",     label: "equals" },
  { value: "regex",     label: "regex" }
]);

function _stringMatches(candidate, term, mode) {
  const cand = String(candidate ?? "");
  const q = String(term ?? "");
  if (!cand || !q) return false;
  const lcCand = cand.toLowerCase();
  const lcQ = q.toLowerCase();
  switch (mode) {
    case "exact":  return lcCand === lcQ;
    case "regex":
      try { return new RegExp(q, "i").test(cand); }
      catch { return false; }
    case "substring":
    default:       return lcCand.includes(lcQ);
  }
}

/* Compare a term against a Set of candidates (statuses). `exact` uses
 * `Set.has(lcQ)`; `substring` / `regex` walk the set. */
function _setMatches(set, term, mode) {
  if (!set || typeof set.has !== "function") return false;
  const q = String(term ?? "");
  if (!q) return false;
  const lcQ = q.toLowerCase();
  if (mode === "exact" || (!mode || mode === "substring")) {
    // For a status Set, "substring" isn't very useful (status ids like
    // "drunk-3" are already tight), but a substring "drunk" naturally
    // matches "drunk-1" .. "drunk-8" — preserve that legacy behavior for
    // the "auto" callers that always pass mode === "substring".
    if (mode === "exact") return set.has(lcQ);
    for (const s of set) if (String(s).toLowerCase().includes(lcQ)) return true;
    return false;
  }
  if (mode === "regex") {
    let re;
    try { re = new RegExp(q, "i"); } catch { return false; }
    for (const s of set) if (re.test(String(s))) return true;
    return false;
  }
  return false;
}

function _itemNameMatches(actor, term, mode) {
  for (const it of (actor.items ?? [])) {
    if (_stringMatches(it?.name, term, mode)) return true;
  }
  return false;
}

function _namedItemMatches(actor, type, term, mode) {
  for (const it of (actor.items ?? [])) {
    if (it?.type !== type) continue;
    if (_stringMatches(it?.name, term, mode)) return true;
  }
  return false;
}

function _pathMatches(actor, term, path, mode) {
  const p = String(path ?? "").trim();
  if (!p) return false;
  let val;
  try { val = foundry.utils.getProperty(actor, p); } catch { return false; }
  if (val == null) return false;
  return _stringMatches(val, term, mode);
}

function matchTerm(actor, term, source = "auto", path = "", mode = "substring") {
  const q = String(term ?? "").trim();
  if (!q) return false;

  switch (source) {
    case "status":
      return _setMatches(actor.statuses, term, mode);
    case "effect":
      for (const e of iterAppliedEffects(actor)) {
        if (e.disabled || e.isSuppressed) continue;
        if (_stringMatches(e.name, term, mode)) return true;
      }
      return false;
    case "item":       return _itemNameMatches(actor, term, mode);
    case "race":       return _namedItemMatches(actor, "race", term, mode);
    case "profession": return _namedItemMatches(actor, "profession", term, mode);
    case "path":       return _pathMatches(actor, term, path, mode);
    case "auto":
    default:
      // Legacy broad scan: statuses + effect names + effect statuses. Uses
      // substring semantics regardless of `mode`.
      if (_setMatches(actor.statuses, term, "substring")) return true;
      for (const e of iterAppliedEffects(actor)) {
        if (e.disabled) continue;
        if (e.isSuppressed) continue;
        if (_stringMatches(e.name, term, "substring")) return true;
        if (_setMatches(e.statuses, term, "substring")) return true;
      }
      return false;
  }
}

/* Normalize the stored `matches` array. Legacy single-string `match`
 * (pre-array schema) migrates on read into a one-row matches array so
 * old saves keep working without a data-side rewrite. Rows saved before
 * per-row source selection default to `source: "auto"` — preserving their
 * original semantics. */
function normalizeMatches(c) {
  const validSources = new Set(MATCH_SOURCES().map(s => s.value));
  const validModes   = new Set(MATCH_MODES.map(m => m.value));
  const clean = (r) => ({
    value:  String(r?.value ?? "").trim(),
    join:   r?.join === "or" ? "or" : "and",
    source: validSources.has(r?.source) ? r.source : "auto",
    path:   String(r?.path ?? "").trim(),
    mode:   validModes.has(r?.mode) ? r.mode : "substring"
  });
  if (Array.isArray(c?.matches)) {
    return c.matches.map(clean).filter(r => r.value);
  }
  const legacy = String(c?.match ?? "").trim();
  return legacy ? [clean({ value: legacy, join: "and" })] : [];
}

/* A condition column is active when its `matches` rows fold truthy.
 *
 * PRECEDENCE (per user spec): OR is grouped TIGHTER than AND. So the
 * expression [A, and:B, or:C] reads as `A AND (B OR C)`, not
 * `(A AND B) OR C`. Concretely: split the row sequence into AND-groups
 * — each AND-group starts on the seed row OR any row whose `join === "and"`;
 * subsequent OR rows are appended to the current group. Each group is
 * OR-folded (any one row matches → group true); the column is active iff
 * ALL groups are true.
 *
 * Worked example rows = [{Cloaked, seed}, {Trance, and}, {Cat, or}]:
 *   groups = [[Cloaked], [Trance, Cat]]
 *   active = match(Cloaked) AND (match(Trance) OR match(Cat)) */
function conditionActive(actor, matches) {
  const rows = normalizeMatches({ matches });
  if (!rows.length) return false;
  const groups = [];
  for (let i = 0; i < rows.length; i++) {
    const startsGroup = i === 0 || rows[i].join === "and";
    if (startsGroup) groups.push([rows[i]]);
    else groups[groups.length - 1].push(rows[i]);
  }
  return groups.every(grp => grp.some(r => matchTerm(actor, r.value, r.source, r.path, r.mode)));
}

/* Pick the image for the current toxicity tier.
 *
 * Selection rule (ranked):
 *   1. Skip columns with no tier image OR not currently active.
 *   2. Prefer the column with the MOST AND-GROUPS — each AND-group is
 *      one independent requirement, so more groups = stricter fit.
 *      Example: `Cloaked AND (Trance OR Cat)` has 2 AND-groups
 *      (Cloaked; Trance/Cat) → beats `Trance OR Cat` (1 AND-group).
 *   3. Tiebreak: FEWER total match rows — a group with two OR-alternates
 *      is broader than one exact term; if two columns have the same
 *      AND-group count, prefer the one with fewer alternate paths.
 *   4. Final tiebreak: leftmost (stable, matches the config order).
 *
 * Why AND-groups rather than row count:
 *   - `[X, or:Y, or:Z]` has 3 rows but only 1 AND-group. It matches 3
 *     state combos — BROADER than `[X]` (1 row, 1 group, 1 combo).
 *   - `[X, and:Y]` and `[X, or:Y]` both have 2 rows; the AND version is
 *     strictly stricter (both required vs. either). Row count can't tell
 *     them apart; AND-group count can (2 vs. 1). */
function selectImage(actor) {
  const { base, conditions } = getConfig(actor);
  const tox = actor.system?.stats?.toxicity ?? {};
  const tier = computeTier(tox.value, tox.max);

  const scoreColumn = (col) => {
    const rows = normalizeMatches({ matches: col.matches });
    let andGroups = 0;
    for (let i = 0; i < rows.length; i++) {
      if (i === 0 || rows[i].join === "and") andGroups++;
    }
    return { andGroups, rowCount: rows.length };
  };

  let bestIdx = -1;
  let bestGroups = -1;
  let bestRows = Infinity;   // primary: max groups, tiebreak: min rows
  for (let i = 0; i < conditions.length; i++) {
    const col = conditions[i];
    if (!col.tiers?.[tier]) continue;
    if (!conditionActive(actor, col.matches)) continue;
    const { andGroups, rowCount } = scoreColumn(col);
    if (andGroups > bestGroups) {
      bestGroups = andGroups; bestRows = rowCount; bestIdx = i;
      continue;
    }
    if (andGroups === bestGroups && rowCount < bestRows) {
      bestRows = rowCount; bestIdx = i;
    }
    // Same score → leftmost wins by strict `>` / `<` on first hit.
  }
  if (bestIdx >= 0) return conditions[bestIdx].tiers[tier];
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
 * (or re-upload) each time. Keyed by `${img}|${tx}|${ty}|${scale}` since the
 * uploaded file is a pure function of those inputs. Values are file PATHS,
 * not data URLs — Foundry v14 rejects base64 URLs in FilePathField (see
 * persistCropAsFile below). Cleared on a slow LRU-ish bound. */
const _cropCache = new Map();
function cropCacheKey(img, c) { return `${img}|${c.tx ?? 0}|${c.ty ?? 0}|${c.scale ?? 1}`; }

/* Deterministic short hex from a cache key — used for the persisted crop
 * filename so re-rasterizing the same (img, tx, ty, scale) overwrites the
 * same file instead of piling up.
 *
 * Deliberately NOT crypto: `crypto.subtle` is only exposed in secure
 * contexts (https:// or localhost), so a self-hosted Foundry served over
 * plain http:// on a LAN IP (e.g. `http://88.96.54.8:30000/`) has
 * `crypto.subtle === undefined` and any SubtleCrypto call throws
 * synchronously. That's what silently broke crop persistence on remote
 * servers while leaving local dev untouched. A 32-bit FNV-1a hash is
 * plenty for filename uniqueness — collisions are cosmetic (one crop's
 * file overwrites another with the same hash), not security-critical. */
function shortHash(text) {
    let h = 0x811c9dc5;                       // FNV offset basis
    const s = String(text ?? "");
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);         // FNV prime, 32-bit
    }
    return ((h >>> 0).toString(16).padStart(8, "0")
         + (Math.imul(h ^ (s.length * 2654435761), 0x01000193) >>> 0).toString(16).padStart(8, "0"));
}

/* Upload a base64 PNG data URL as an actual file under the world's data
 * folder and return the resulting file path. Foundry v14's FilePathField
 * sanitizer rejects `data:` URLs unconditionally (the message mentions
 * FILES_UPLOAD but the reject is for anyone), so passing a data URL to
 * `prototypeToken.texture.src` or `token.texture.src` fails on the server.
 *
 * Returns null on any failure (missing FilePicker.upload permission,
 * network error, no world context) — callers fall back to the raw image
 * so the swap still happens with un-cropped framing rather than throwing. */
export async function persistCropAsFile(dataUrl, cacheKey) {
    if (!dataUrl?.startsWith?.("data:")) return dataUrl ?? null;
    /* Namespaced path FIRST. The bare `globalThis.FilePicker` is a v13+
     * deprecation shim that logs a compatibility warning the moment it's READ,
     * and `??` wouldn't fall through it (the shim returns a value), so reading it
     * first fired the warning every crop. Prefer the new location and only fall
     * back to the global on older cores that lack it. Mirrors FilePickerImpl(). */
    const FP = foundry?.applications?.apps?.FilePicker?.implementation
            ?? globalThis.FilePicker;
    if (!FP?.upload) {
        console.warn(`${MODULE_ID} | crop upload: FilePicker.upload unavailable`);
        return null;
    }
    const worldId = game.world?.id;
    if (!worldId) {
        console.warn(`${MODULE_ID} | crop upload: no world id`);
        return null;
    }
    try {
        const res  = await fetch(dataUrl);
        const blob = await res.blob();
        const hash = shortHash(cacheKey);
        const dir  = `worlds/${worldId}/${MODULE_ID}-portrait-crops`;
        try { await FP.createDirectory("data", dir); }
        catch (dirErr) {
            /* Foundry's createDirectory throws when the directory already
             * exists (expected) but also when the caller lacks permission
             * (which is what silently breaks server deploys — a player-role
             * user or a locked-down world config can't create under
             * data/worlds/…). Log the error verbatim so we can distinguish
             * "already exists" from "forbidden" in the console. */
            const msg = String(dirErr?.message ?? dirErr ?? "").toLowerCase();
            if (!msg.includes("exist")) {
                console.warn(`${MODULE_ID} | crop upload: createDirectory failed for "${dir}" — this usually means the current user lacks the FILES_UPLOAD permission or the world data folder is read-only`, dirErr);
                /* Do NOT return here — a re-uploaded module can find the dir
                 * already there but createDirectory's error message doesn't
                 * always match. Fall through to upload; if that fails too,
                 * we'll catch below. */
            }
        }
        const file   = new File([blob], `crop_${hash}.png`, { type: "image/png" });
        const result = await FP.upload("data", dir, file, {}, { notify: false });
        if (!result?.path) {
            console.warn(`${MODULE_ID} | crop upload: FP.upload returned no path (dir=${dir})`, result);
        }
        return result?.path ?? null;
    } catch (err) {
        console.warn(`${MODULE_ID} | crop upload failed`, err);
        return null;
    }
}

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
   * output every time an AE landed. */
  const cropState = actor.getFlag?.(MODULE_ID, PORTRAIT_CROP_FLAG);
  let tokenTextureSrc = target;   // raw fallback so the tier swap always shows
  let rasterizeFailed = false;
  if (cropState) {
    const key = cropCacheKey(target, cropState);
    let cachedPath = _cropCache.get(key);
    if (!cachedPath) {
      try {
        const dataUrl = await rasterizePortraitCrop(target, cropState);
        if (!dataUrl) {
          rasterizeFailed = true;
          console.warn(`${MODULE_ID} | portrait crop: rasterize returned null for ${actor.name} (target=${target})`);
        } else {
          const uploadedPath = await persistCropAsFile(dataUrl, key);
          if (uploadedPath) {
            if (_cropCache.size > 32) _cropCache.clear(); // simple bound
            _cropCache.set(key, uploadedPath);
            cachedPath = uploadedPath;
          } else {
            rasterizeFailed = true;
            console.warn(`${MODULE_ID} | portrait crop: upload returned null for ${actor.name} (target=${target}) — check FilePicker upload permission`);
          }
        }
      } catch (err) {
        rasterizeFailed = true;
        console.warn(`${MODULE_ID} | portrait crop rasterize/upload failed for ${actor.name} — falling back to raw target`, err);
      }
    }
    if (cachedPath) tokenTextureSrc = cachedPath;
    /* If the crop path failed AND the token is already pointing at a
     * cropped file for this actor (previously succeeded), leave the
     * token alone — better a stale-tier crop than a wrong-tier raw
     * blast. Detected by the crop directory prefix. */
    else if (rasterizeFailed) {
      const cropDirPrefix = `worlds/${game.world?.id ?? ""}/${MODULE_ID}-portrait-crops/`;
      const currentSrc = actor.prototypeToken?.texture?.src ?? "";
      if (currentSrc.startsWith(cropDirPrefix)) return;
    }
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

/* Equip / un-equip an armor piece flips WitcherActiveEffect.isSuppressed
 * on every AE that piece carries — which means a clothes item with a
 * "trance" AE goes from applying-to-the-actor to not-applying (or vice
 * versa) purely via the item's `system.equipped` toggle, with no
 * ActiveEffect document ever changing. Watch armor equip changes so the
 * portrait re-derives when the equip state does. */
Hooks.on("updateItem", (item, changes) => {
  if (item?.type !== "armor") return;
  if (!foundry.utils.hasProperty(changes, "system.equipped")) return;
  const actor = item.parent;
  if (actor?.documentName === "Actor") schedule(actor);
});

/* Effect-change hook. In Foundry v14 an item's `transfer:true` AE lives
 * on the ITEM (its `parent` is the Item), even while surfaced on the
 * actor via allApplicableEffects — so we have to walk one level up to
 * reach the actor. Also handle the direct actor-authored AE case (parent
 * IS the actor) and the legacy origin-pointer case (v10-13 style). */
function ownerActorOf(effect) {
  const parent = effect?.parent;
  if (parent?.documentName === "Actor") return parent;
  if (parent?.documentName === "Item" && parent.parent?.documentName === "Actor") {
    return parent.parent;
  }
  const origin = effect?.origin;
  if (origin) {
    try {
      const doc = fromUuidSync(origin);
      if (doc?.documentName === "Item" && doc.parent?.documentName === "Actor") return doc.parent;
      if (doc?.documentName === "Actor") return doc;
    } catch (_) { /* stale origin — fall through */ }
  }
  return null;
}
function onEffectChange(effect) {
  const actor = ownerActorOf(effect);
  if (actor) schedule(actor);
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
      <button type="button" class="wou-vp-clear" data-action="clear" data-col="${col}" data-tier="${tier}" title="${t("WITCHER.Chrome.PortraitToxicity.Text.Clear", "Clear")}"><i class="fa-solid fa-xmark"></i></button>
    </div>
  </td>`;
}

function gridHtml(actor, state) {
  const ranges = tierRanges(actor.system?.stats?.toxicity?.max);
  const conds = state.conditions;
  const maxTox = Number(actor.system?.stats?.toxicity?.max) || 100;

  const headCols = conds.map((c, i) => {
    /* Render at least one input row per column so a fresh column has
     * something to type into. Row 0 doesn't get an operator selector —
     * it seeds the fold. Rows 1..N-1 render a compact AND/OR dropdown
     * before the value input, plus a per-row remove button. An "+ row"
     * button appends another match input. */
    const rows = c.matches?.length ? c.matches : [{ value: "", join: "and", source: "auto", path: "", mode: "substring" }];
    const rowHtml = rows.map((r, ri) => {
      const opSelector = ri === 0
        ? `<span class="wou-vp-matchop is-seed" aria-hidden="true">${t("WITCHER.Chrome.PortraitToxicity.Text.Where", "where")}</span>`
        : `<select class="wou-vp-matchop" data-col="${i}" data-row="${ri}" title="${t("WITCHER.Chrome.PortraitToxicity.Text.CombineWithRowsAbove", "Combine with rows above")}">` +
              `<option value="and"${r.join === "or" ? "" : " selected"}>${t("WITCHER.Chrome.PortraitToxicity.Text.AND", "AND")}</option>` +
              `<option value="or"${r.join === "or" ? " selected" : ""}>${t("WITCHER.Chrome.PortraitToxicity.Text.OR", "OR")}</option>` +
          `</select>`;
      const source = String(r.source ?? "auto");
      const srcSelector = `<select class="wou-vp-matchsrc" data-col="${i}" data-row="${ri}" title="${t("WITCHER.Chrome.PortraitToxicity.Text.WhatToScanForThisTerm", "What to scan for this term")}">` +
        MATCH_SOURCES().map(s =>
          `<option value="${s.value}"${source === s.value ? " selected" : ""}>${escapeAttr(s.label)}</option>`
        ).join("") +
        `</select>`;
      // Mode selector — hidden for `auto` (which always uses substring on
      // its broad scan; a mode toggle would be noise). For every named
      // source, show `contains / equals / regex` so the user can tighten
      // "cat" from "matches Cat School Witcher" to an exact "Cat".
      const mode = String(r.mode ?? "substring");
      const modeSelector = source === "auto" ? "" :
        `<select class="wou-vp-matchmode" data-col="${i}" data-row="${ri}" title="${t("WITCHER.Chrome.PortraitToxicity.Text.MatchMode", "Match mode")}">` +
        MATCH_MODES.map(m =>
          `<option value="${m.value}"${mode === m.value ? " selected" : ""}>${escapeAttr(m.label)}</option>`
        ).join("") +
        `</select>`;
      const pathInput = source === "path"
        ? `<input class="wou-vp-cpath" type="text" data-col="${i}" data-row="${ri}" value="${escapeAttr(r.path ?? "")}" placeholder="system.stats.toxicity.value" title="${t("WITCHER.Chrome.PortraitToxicity.Text.ActorDataPathToRead", "Actor data path to read")}" />`
        : "";
      const remove = ri === 0
        ? ""
        : `<button type="button" class="wou-vp-removerow" data-action="remove-row" data-col="${i}" data-row="${ri}" title="${t("WITCHER.Chrome.PortraitToxicity.Text.RemoveThisRow", "Remove this row")}"><i class="fa-solid fa-xmark"></i></button>`;
      return `<div class="wou-vp-matchrow" data-col="${i}" data-row="${ri}">
        ${opSelector}
        ${srcSelector}
        ${modeSelector}
        <input class="wou-vp-cmatch" type="text" data-col="${i}" data-row="${ri}" value="${escapeAttr(r.value)}" placeholder="${t("WITCHER.Chrome.PortraitToxicity.Text.TermToMatch", "term to match")}" />
        ${pathInput}
        ${remove}
      </div>`;
    }).join("");
    return `<th class="wou-vp-condhead" data-col="${i}">
      <button type="button" class="wou-vp-removecol" data-action="remove-col" data-col="${i}" title="${t("WITCHER.Chrome.PortraitToxicity.Text.RemoveThisCondition", "Remove this condition")}"><i class="fa-solid fa-xmark"></i></button>
      <div class="wou-vp-matchrows" data-col="${i}">${rowHtml}</div>
      <button type="button" class="wou-vp-addrow" data-action="add-row" data-col="${i}" title="${t("WITCHER.Chrome.PortraitToxicity.Text.AddMatchRow", "Add match row")}"><i class="fa-solid fa-plus"></i> row</button>
    </th>`;
  }).join("");

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
    <details class="wou-vp-note">
      <summary><i class="fa-solid fa-circle-info"></i> ${t("WITCHER.Chrome.PortraitToxicity.Text.HowItWorks", "How variable portraits work")}</summary>
      <p class="wou-vp-note-lead">A different face at different <b>toxicity</b> levels and under <b>conditions</b>.</p>
      <ul class="wou-vp-note-list">
        <li><b>Rows are toxicity bands</b> — Q1–Q4 quarter this actor's max (${maxTox}); OD1–OD4 are overdose past it.</li>
        <li><b>Base</b> is the fallback face. Set <b>Q1 · Base</b> to the everyday portrait so it swaps back at full sobriety.</li>
        <li><b>Condition columns</b> swap the face when they match — per row, pick what to scan (status, effect, item, race, profession, or a data path) and a mode: <b>contains</b> / <b>equals</b> / <b>regex</b>.</li>
        <li>Stack rows with <b>AND</b> / <b>OR</b> (OR binds tighter). When several columns match, the <b>most specific</b> one wins.</li>
      </ul>
    </details>
    <div class="wou-vp-scroll">
      <table class="wou-vp-table">
        <thead>
          <tr>
            <th class="wou-vp-corner"></th>
            <th class="wou-vp-basehead"><span class="wou-vp-colname">${t("WITCHER.Chrome.PortraitToxicity.Text.Base", "Base")}</span><span class="wou-vp-colsub">${t("WITCHER.Chrome.PortraitToxicity.Text.NoCondition", "no condition")}</span></th>
            ${headCols}
            <th class="wou-vp-addcol"><button type="button" data-action="add-col" title="${t("WITCHER.Chrome.PortraitToxicity.Text.AddConditionColumn", "Add condition column")}"><i class="fa-solid fa-plus"></i> ${t("WITCHER.Chrome.PortraitToxicity.Text.Condition", "Condition")}</button></th>
          </tr>
        </thead>
        <tbody>${bodyRows}</tbody>
      </table>
    </div>`;
}

/* Read the current grid DOM back into a {base, conditions} state object. Used
 * to preserve edits across add/remove-column re-renders and on save. */
function collect(root) {
  const condCount = root.querySelectorAll(".wou-vp-condhead").length;
  const base = new Array(TIER_COUNT).fill("");
  const conditions = [];
  for (let i = 0; i < condCount; i++) {
    /* Pair each value input in this column with its sibling join selector.
     * Row 0's join dropdown is rendered as an inert span (seed row), so we
     * fall back to "and" — the folding eval ignores rows[0].join anyway. */
    const rowNodes = Array.from(root.querySelectorAll(`.wou-vp-matchrow[data-col="${i}"]`));
    const matches = rowNodes.map((row, ri) => {
      const value = row.querySelector(".wou-vp-cmatch")?.value?.trim() ?? "";
      const joinSel = row.querySelector("select.wou-vp-matchop");
      const join = ri === 0 ? "and" : (joinSel?.value === "or" ? "or" : "and");
      const source = row.querySelector("select.wou-vp-matchsrc")?.value ?? "auto";
      const path = row.querySelector(".wou-vp-cpath")?.value?.trim() ?? "";
      // Mode select is only rendered for non-auto sources; when omitted,
      // fall back to substring (the auto default). collect runs on every
      // re-render + save so the value round-trips faithfully.
      const mode = row.querySelector("select.wou-vp-matchmode")?.value ?? "substring";
      return { value, join, source, path, mode };
    });
    conditions.push({
      name:  "",   /* cosmetic column-name field removed; kept empty for schema compat */
      matches,
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
    ui.notifications?.error?.(tFormat("WITCHER.Notify.Portrait.DialogV2Unavailable", { mod: MODULE_ID }, "{mod} | DialogV2 unavailable on this Foundry build."));
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
    window: {
      title: tFormat("WITCHER.Dialog.Portrait.Variable", { actor: actor.name }, "Variable Portrait — {actor}"),
      icon: "fa-solid fa-flask-vial",
      resizable: true
    },
    classes: ["wou-vp-dialog"],
    /* Wider default so 4 condition columns fit without horizontal scroll
     * (base + 4 conditions × ~9rem each + tier-label rail). Height auto
     * lets the 8-tier grid + note block set its own size. */
    position: { width: 960, height: "auto" },
    content: `<div class="wou-vp-host">${gridHtml(actor, initial)}</div>`,
    buttons: [
      {
        action: "save",
        label: t("WITCHER.Common.Save", "Save"),
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
            ui.notifications?.error?.(t("WITCHER.Notify.Portrait.SaveFailed", "Failed to save variable portrait config."));
          }
        }
      },
      { action: "cancel", label: t("WITCHER.Common.Cancel", "Cancel"), icon: "fa-solid fa-xmark" }
    ],
    rejectClose: false,
    render: (_event, dialog) => {
      const root = dialog?.element ?? dialog;

      /* Use capture phase so DialogV2's own action dispatch (which
       * handles the outer Save/Cancel buttons and can swallow bubbling
       * clicks on unknown data-action values) doesn't intercept the
       * add-col / remove-col / pick / clear actions authored INSIDE
       * the content — without capture, only the very first add-col
       * click was landing before DialogV2's handler consumed the rest. */
      root.addEventListener("click", async (ev) => {
        const el = ev.target.closest("[data-action]");
        if (!el) return;
        const action = el.dataset.action;
        /* Only intercept OUR content-scope actions; leave the dialog's
         * save/cancel to DialogV2. */
        if (!["add-col", "remove-col", "add-row", "remove-row", "pick", "clear"].includes(action)) return;

        if (action === "add-col") {
          ev.preventDefault();
          ev.stopPropagation();
          const state = collect(root);
          state.conditions.push({
            name: "",
            matches: [{ value: "", join: "and", source: "auto", path: "", mode: "substring" }],
            tiers: new Array(TIER_COUNT).fill("")
          });
          renderGrid(root, actor, state);
          return;
        }
        if (action === "remove-col") {
          ev.preventDefault();
          ev.stopPropagation();
          const col = Number(el.dataset.col);
          const state = collect(root);
          state.conditions.splice(col, 1);
          renderGrid(root, actor, state);
          return;
        }
        if (action === "add-row") {
          ev.preventDefault();
          ev.stopPropagation();
          const col = Number(el.dataset.col);
          const state = collect(root);
          const c = state.conditions[col];
          if (c) {
            if (!Array.isArray(c.matches) || !c.matches.length) c.matches = [{ value: "", join: "and" }];
            c.matches.push({ value: "", join: "and", source: "auto", path: "", mode: "substring" });
          }
          renderGrid(root, actor, state);
          return;
        }
        if (action === "remove-row") {
          ev.preventDefault();
          ev.stopPropagation();
          const col = Number(el.dataset.col);
          const row = Number(el.dataset.row);
          const state = collect(root);
          const c = state.conditions[col];
          if (c && Array.isArray(c.matches) && row >= 0 && row < c.matches.length) {
            c.matches.splice(row, 1);
            if (!c.matches.length) c.matches = [{ value: "", join: "and" }];
          }
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
          if (!FP) { ui.notifications?.error?.(t("WITCHER.Notify.Portrait.NoFilePicker", "FilePicker not available.")); return; }
          new FP({
            type: "image",
            current: cell.dataset.path || "",
            callback: (path) => setCellImage(root, col, tier, path)
          }).render(true);
          return;
        }
      }, { capture: true });

      /* Source dropdown flips a row between "auto/status/effect/..." and
       * "path" (path needs its own text input) AND between "auto" and named
       * sources (named sources need the mode dropdown; auto hides it). A
       * full grid re-render (via collect + renderGrid) rewrites the row so
       * the extra controls appear/disappear while preserving every other
       * edit. */
      root.addEventListener("change", (ev) => {
        const sel = ev.target?.closest?.(".wou-vp-matchsrc");
        if (!sel) return;
        const state = collect(root);
        renderGrid(root, actor, state);
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
          thumb.title = v || t("WITCHER.Chrome.PortraitToxicity.Tip.ChooseImage", "Choose image");
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
    ? [{ name: t("WITCHER.Chrome.PortraitToxicity.Text.Trance", "Trance"), matches: [{ value: "trance", join: "and" }], tiers: tranceTiers }]
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
function injectVariablePortraitButton(app, element) {
  try {
    if (!element) return;
    const actor = app?.actor;
    if (!actor) return;
    if (!isVariablePortraitEnabled(actor)) return;
    if (!(game.user?.isGM || actor.isOwner)) return;

    // Sits in the bottom-right corner of the portrait itself (character sheet's
    // `.wcs-portrait`), not the window header. Same shared `.wdm-vp-corner`
    // treatment used by the character/inventory chrome portraits.
    const portrait = element.querySelector?.(".wcs-portrait");
    if (!portrait) return;
    // Idempotent: re-renders happen on every form change, don't pile up.
    if (portrait.querySelector('[data-wdm-vp-btn]')) return;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "wdm-vp-corner";
    btn.dataset.wdmVpBtn = "1";
    btn.innerHTML = '<i class="fa-solid fa-flask-vial"></i>';
    btn.dataset.tooltip = t("WITCHER.Chrome.PortraitToxicity.Text.VariablePortrait", "Variable portrait");
    btn.setAttribute("aria-label", t("WITCHER.Chrome.PortraitToxicity.Text.VariablePortrait", "Variable portrait"));
    btn.addEventListener("click", async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      try { await openVariablePortraitConfig(actor); }
      catch (err) { console.error(`${MODULE_ID} | open variable portrait config failed`, err); }
    });
    portrait.appendChild(btn);
  } catch (err) {
    console.warn(`${MODULE_ID} | variable portrait sheet button inject failed`, err);
  }
}

/* renderActorSheetV2 catches every V2 actor sheet via Foundry's parent-class
 * hook chain (renderWitcherCharacterSheet → renderWitcherActorSheet →
 * renderActorSheetV2 → …). One handler covers all subclasses. */
Hooks.on("renderActorSheetV2", injectVariablePortraitButton);
