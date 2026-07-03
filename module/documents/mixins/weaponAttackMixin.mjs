/**
 * weaponAttackMixin — actor method for rolling a weapon attack.
 *
 * Composed onto WitcherActor (documents/actor.mjs). Exposes:
 *   actor.weaponAttack(weapon, options)   — roll an attack with a weapon
 *
 * Fired by clicking a weapon NAME in the actor-sheet combat tab or the
 * combat dock. Opens the attack modifier dialog (applications/attackDialog),
 * folds in everything the player declares (strike type, extra action, aiming,
 * hit location, situational mods, range bracket, live weather penalty), then
 * posts a chat card per shot through `extendedRoll` so the d10 explode/fumble
 * chain is uniform with skill rolls.
 *
 * Attack roll = 1d10 + (stat + skill rank + skill mod) + weapon accuracy
 *               + declared modifiers (the dialog's modTotal) + a flat caller
 *               modifier.
 *
 * The reads use the weapon's EFFECTIVE stats (post-enhancement) so socketed
 * runes / mods are already folded into accuracy, damage, types and qualities.
 *
 * Extra action spends 3 STA via combatRoundMixin.spendStamina. Strong strikes
 * carry a damage multiplier; fast strikes roll twice (two shots). Hit-location
 * damage multipliers are surfaced on the card; the damage pipeline applies
 * them downstream.
 *
 * NOTE: this layer does not yet spend ammunition — firing/consumption is the
 * next step. The roll reads what's chambered but leaves the count alone.
 */

import { extendedRoll } from "../../rolls/extendedRoll.mjs";
import { openAttackDialog, isRangedWeapon, isOffhandWeapon } from "../../applications/attackDialog.mjs";
import { getActiveStrikeTable, getActiveCombatActions } from "../../data/combatExtended/actions.mjs";
/* Guard-attack contribution moved into attackDialog.mjs so it shows in
 * the pre-hit modifier breakdown alongside the other running-total
 * chips. This mixin doesn't need to re-read the guard — decl.modTotal
 * carries the +2/−2 in. */
import { WEAPON_QUALITIES as WQ_CATALOG } from "../../setup/config.mjs";
import { STRIKE_TYPES, ATTACK_LOCATIONS, rollHitLocation, EXTRA_ACTION,
         getActiveWeaponQualities, WEAPON_QUALITIES, shieldBashDamage }
    from "../../setup/config.mjs";
import { isAdrenalineEnabled, adrenalineStaPerDie } from "../../api/adrenaline.mjs";
import { isCombatExtendedEnabled } from "../../api/homebrew.mjs";
import { hasWRPerk, wrHeroic } from "../../api/witcherReborn.mjs";
import { getActiveOpenCategoryBonuses, sumOpenCategoryWa, damageTailFromOpenCategory, grantedQualitiesFromOpenCategory, grantedQualityValuesFromOpenCategory } from "../../mechanics/openCategoryBonuses.mjs";
import { attackMod as statusAttackMod, clauseFor as _clauseFor, cannotDefend } from "../../mechanics/statusEngine.mjs";
import { contextualPhysicalMod, contextualPhysicalChip } from "../../mechanics/holdModifiers.mjs";
import { emitApplyDamage, emitApplyStatus, emitReduceReliability, qualitiesToDamageFlags, requestDefenseFromOwner } from "../../setup/socketHook.mjs";
import { critSeverityFromDelta } from "../../combat/critSeverity.mjs";
import { getActorTarget } from "../../chrome/chrome/context-menu-actor.js";

const SYSTEM_ID = "witcher-ttrpg-death-march";
const esc    = (s) => Handlebars.escapeExpression(String(s ?? ""));
const signed = (n) => `${n >= 0 ? "+" : ""}${n}`;

/**
 * Wrap the entire attack chat card in ONE collapsible `<details
 * class="wdm-attack-card">` element, append optional new content to
 * its body, and update the master one-liner summary.
 *
 *   appendAttackResult(msg, { fragment: '<div>…</div>', summaryAdd: 'HIT' });
 *
 * Used by every contributor that wants its info to live on the same
 * card (verdict patch, damage roll, applied breakdown, crit wound,
 * status riders, stress save, parry-stagger, block-spend). Builds the
 * outer wrap on first call (capturing the existing pre-wrap content
 * into the body); subsequent calls find the wrap, append into its
 * body, and extend the summary's parts list.
 *
 *   Summary parts are stored as JSON on `data-summary-parts` so the
 *   running one-liner survives re-renders. Each part is wrapped in a
 *   styled chip (.wdm-card-sum-part), with chevron separators between.
 *
 *   `kind` on a summary part lets the CSS tint it differently
 *   (verdict / damage / status / crit / fumble). Default kind is "info". */
function renderCardSummary(parts, actionHtml = "") {
    let chipHtml;
    if (!parts.length) {
        chipHtml = `<span class="wdm-card-sum-part">Attack</span>`;
    } else {
        chipHtml = parts.filter(p => p && (typeof p === "string" || p.label)).map(p => {
            const label = typeof p === "string" ? p : p.label;
            const kind  = typeof p === "object" ? (p.kind || "info") : "info";
            const ico   = typeof p === "object" && p.icon ? `<i class="fa-solid ${p.icon}"></i> ` : "";
            return `<span class="wdm-card-sum-part is-${kind}">${ico}${Handlebars.escapeExpression(label)}</span>`;
        }).join(`<span class="wdm-card-sum-sep">·</span>`);
    }
    const action = actionHtml
        ? `<span class="wdm-card-sum-action">${actionHtml}</span>`
        : "";
    return `<i class="fa-solid fa-crosshairs wdm-card-sum-ico"></i>${chipHtml}${action}`;
}

/* Per-message append queue.
 *
 * Two contributors can fire appendAttackResult on the same message at
 * almost the same time (e.g. autoApplyCriticalWound stamps its own
 * line WHILE the createItem hook → onCreateCriticalWoundStress chain
 * is also writing a stress-break line). Without serialization both
 * read the BEFORE content, both append their own fragment, and the
 * second writer overwrites the first → one of the two contributions
 * silently disappears.
 *
 * Map from message uuid/id → tail Promise. Each append chains off
 * the previous; the entry is cleaned up once it's the current tail
 * and resolves, so the map doesn't leak. */
const _appendQueues = new Map();

export async function appendAttackResult(attackMsg, opts = {}) {
    if (!attackMsg) return;
    const key  = attackMsg.uuid ?? attackMsg.id ?? attackMsg;
    const prev = _appendQueues.get(key) ?? Promise.resolve();
    const next = prev
        .catch(() => {})     // don't propagate prior failures into ours
        .then(() => _doAppendAttackResult(attackMsg, opts));
    _appendQueues.set(key, next);
    try { return await next; }
    finally {
        if (_appendQueues.get(key) === next) _appendQueues.delete(key);
    }
}

async function _doAppendAttackResult(attackMsg, { fragment = "", summaryAdd = "", summaryAction = null } = {}) {
    if (!attackMsg) return;
    const tmp = document.createElement("div");
    tmp.innerHTML = String(attackMsg.content ?? "");
    let card = tmp.querySelector("details.wdm-attack-card");
    if (!card) {
        /* First call — wrap all existing content into the body of a
         * new outer collapsible. Cards start COLLAPSED so the chat
         * stays compact; users click the chevron OR the in-summary
         * action button (e.g. Roll Damage) without expanding. */
        card = document.createElement("details");
        card.className = "wdm-attack-card";
        card.open = false;       // user spec: "start collapsed"
        card.dataset.summaryParts = "[]";
        const sumEl  = document.createElement("summary");
        sumEl.className = "wdm-attack-card-summary";
        const bodyEl = document.createElement("div");
        bodyEl.className = "wdm-attack-card-body";
        while (tmp.firstChild) bodyEl.appendChild(tmp.firstChild);
        card.appendChild(sumEl);
        card.appendChild(bodyEl);
        tmp.appendChild(card);
    }
    const body     = card.querySelector(".wdm-attack-card-body");
    const summaryEl = card.querySelector(".wdm-attack-card-summary");
    if (fragment) body.insertAdjacentHTML("beforeend", fragment);

    /* Maintain the typed summary parts list. */
    let parts = [];
    try { parts = JSON.parse(card.dataset.summaryParts || "[]"); }
    catch (_) { parts = []; }
    if (summaryAdd) {
        parts.push(typeof summaryAdd === "object" ? summaryAdd : String(summaryAdd));
    }
    card.dataset.summaryParts = JSON.stringify(parts);

    /* Action slot: persists across appends. Stored as raw HTML on a
     * data attribute. Pass `{ summaryAction: null }` to leave it as-is;
     * pass `{ summaryAction: "" }` to clear it; pass an HTML string
     * to set/replace it. */
    let actionHtml = card.dataset.summaryActionHtml || "";
    if (summaryAction !== null && summaryAction !== undefined) {
        actionHtml = String(summaryAction);
        card.dataset.summaryActionHtml = actionHtml;
    }

    summaryEl.innerHTML = renderCardSummary(parts, actionHtml);
    try { await attackMsg.update({ content: tmp.innerHTML }); }
    catch (err) { console.warn(`${SYSTEM_ID} | appendAttackResult update failed`, err); }
}

/* Default location filter applied to a stunSave rider when the quality's
 * own config doesn't specify `locations`.  RAW Core p.72 Stun sidebar:
 * "Head/torso hits force a Stun save…". */
const DEFAULT_STUN_LOCATIONS = ["head", "torso"];

/** Look up a quality's rider config from the active catalog.  Returns
 *  null when the quality has no rider or isn't in the catalog. */
function riderForQuality(key) {
    const cat = getActiveWeaponQualities() ?? WEAPON_QUALITIES;
    return cat[key]?.rider ?? null;
}

/** Resolve a set of quality KEYS to display labels via the active catalog,
 *  folding in any parameter value as "Label(value suffix)". Mirrors the dock's
 *  weaponQualityLabels so the card matches the combat-dock row. */
function qualityLabels(keys = [], values = {}, catalog = null) {
    if (!keys.length) return [];
    const cat = catalog ?? getActiveWeaponQualities() ?? WEAPON_QUALITIES;
    return keys.map((key) => {
        const entry = cat[key] ?? WEAPON_QUALITIES[key];
        if (!entry) return null;
        const param = entry.param ?? WEAPON_QUALITIES[key]?.param ?? null;
        let label = entry.label;
        if (param) {
            const raw = values[key];
            const v   = raw == null ? "" : String(raw).trim();
            if (v.length) label = `${entry.label}(${v}${param.suffix ?? ""})`;
        }
        return label;
    }).filter(Boolean);
}

/** The raw quality KEYS + parameter map on the shot.  Mirrors
 *  shotQualityLabels but skips localization — used for downstream rider logic
 *  (the damage button's post-hit status applications). */
function shotQualityRiders(weapon, ammoItem = undefined) {
    const wKeys   = weapon.system?.effective?.qualities      ?? weapon.system?.qualities      ?? [];
    const wValues = weapon.system?.effective?.qualityValues  ?? weapon.system?.qualityValues  ?? {};
    const ammo    = (ammoItem !== undefined) ? ammoItem : defaultShotAmmo(weapon);
    const aKeys   = ammo ? (ammo.system?.qualities ?? [])     : [];
    const aValues = ammo ? (ammo.system?.qualityValues ?? {}) : {};
    return {
        keys:   [...new Set([...wKeys, ...aKeys])],
        values: { ...wValues, ...aValues }   // ammo wins on conflict (rare)
    };
}

/** Every quality on the shot: the weapon's effective qualities plus those of
 *  the round it fires. Pass `ammoItem` to use a specific round (a Fast strike
 *  can loose two different arrows); omit it to resolve the default loaded /
 *  nocked round. Deduped by label so a shared quality isn't listed twice. */
function shotQualityLabels(weapon, ammoItem = undefined) {
    const cat = getActiveWeaponQualities() ?? WEAPON_QUALITIES;
    const wq  = qualityLabels(
        weapon.system?.effective?.qualities ?? weapon.system?.qualities ?? [],
        weapon.system?.effective?.qualityValues ?? weapon.system?.qualityValues ?? {},
        cat
    );
    const ammo = (ammoItem !== undefined) ? ammoItem : defaultShotAmmo(weapon);
    const aq = ammo ? qualityLabels(ammo.system?.qualities ?? [], ammo.system?.qualityValues ?? {}, cat) : [];
    return [...new Set([...wq, ...aq])];
}

/** True when ANY of the weapon's effective qualities carries the
 *  `ignoresRepositionDistance` flag (e.g. Long Reach). Used by the
 *  multi-attack loop to decide whether a defender's successful Reposition
 *  voids the follow-up Fast-attack swing. Reads from the live qualities
 *  catalog so the GM's editor overrides take effect at runtime. */
function weaponIgnoresRepositionDistance(weapon) {
    const cat = getActiveWeaponQualities() ?? WEAPON_QUALITIES;
    const keys = weapon?.system?.effective?.qualities ?? weapon?.system?.qualities ?? [];
    for (const k of keys) {
        const entry = cat[k] ?? WEAPON_QUALITIES[k];
        if (entry?.ignoresRepositionDistance === true) return true;
    }
    return false;
}

/* ── EO reach helpers (Long / Superior / Extreme Reach — EO p.7-8) ─────
 * Each reach quality carries:
 *   reachExtendMeters       — extra reach beyond normal melee
 *   reachAdjacentPenalty    — penalty applied to attacks vs an ADJACENT
 *                             defender (≤ 1.5m in our default grid)
 *   reachAdjacentPommelOnly — adjacent attacks downgrade to pommel
 *   reachAdjacentNoAttack   — adjacent attacks refuse outright
 * Returns the union of the wielded weapon's reach fields (the max of each
 * field across the weapon's qualities, since stacking reach qualities is
 * an authoring mistake — we surface the worst penalty in that case). */
function weaponReachInfo(weapon) {
    const cat = getActiveWeaponQualities() ?? WEAPON_QUALITIES;
    const keys = weapon?.system?.effective?.qualities ?? weapon?.system?.qualities ?? [];
    let reachExtendMeters    = 0;
    let reachAdjacentPenalty = 0;
    let pommelOnly = false;
    let noAttack   = false;
    let sourceKey  = "";
    for (const k of keys) {
        const entry = cat[k] ?? WEAPON_QUALITIES[k];
        if (!entry) continue;
        const ex  = Number(entry.reachExtendMeters)    || 0;
        const pen = Number(entry.reachAdjacentPenalty) || 0;
        if (ex > reachExtendMeters) { reachExtendMeters = ex; sourceKey = k; }
        if (pen < reachAdjacentPenalty) reachAdjacentPenalty = pen;
        if (entry.reachAdjacentPommelOnly) pommelOnly = true;
        if (entry.reachAdjacentNoAttack)   noAttack   = true;
    }
    return { reachExtendMeters, reachAdjacentPenalty, pommelOnly, noAttack, sourceKey };
}

/** Chebyshev distance in metres between the actor's controlled token and
 *  the defender token / actor. Diagonal-adjacent counts as 1 tile (2 m
 *  at 1.5 m/tile), matching the Witcher system's grid model — Foundry's
 *  canvas.grid.measureDistance is intentionally NOT used because it
 *  respects the scene's diagonal-cost setting (5-10-5 / Euclidean) and
 *  would misreport diagonals. Returns null when either token is missing. */
function adjacencyDistanceMeters(attacker, defenderActor, defenderToken) {
    try {
        const aTok = attacker?.getActiveTokens?.()?.[0] ?? null;
        const dTok = defenderToken
            ?? defenderActor?.getActiveTokens?.()?.[0]
            ?? (Array.from(game.user?.targets ?? [])[0] ?? null);
        if (!aTok || !dTok) return null;
        const a = aTok.center ?? aTok;
        const d = dTok.center ?? dTok;
        const ax = Number(a?.x); const ay = Number(a?.y);
        const dx = Number(d?.x); const dy = Number(d?.y);
        if (!Number.isFinite(ax) || !Number.isFinite(dx)) return null;
        const chebyPx = Math.max(Math.abs(ax - dx), Math.abs(ay - dy));
        const sz  = Number(canvas?.scene?.grid?.size)     || 100;
        const gd  = Number(canvas?.scene?.grid?.distance) || 1.5;
        return (chebyPx / sz) * gd;
    } catch (_) { return null; }
}

/** The round a weapon fires by default — chambered for crossbows, nocked
 *  (selected) for bows, null for melee. */
function defaultShotAmmo(weapon) {
    if (!weapon.usesAmmo) return null;
    if (weapon.hasChamber) {
        if ((Number(weapon.system?.loaded?.count) || 0) <= 0) return null;
        const ref = weapon.system?.loaded?.uuid;
        return (ref && typeof fromUuidSync === "function") ? fromUuidSync(ref) : null;
    }
    return weapon.getSelectedAmmo?.() ?? null;
}

/** Localize a stat label, falling back to the upper-cased key. */
function statName(statKey) {
    const key = String(statKey ?? "").toLowerCase();
    const out = game.i18n.localize(CONFIG.WITCHER.statLabel(key));
    return (!out || out.startsWith("WITCHER.")) ? key.toUpperCase() : out;
}

/** Build the attack chat-card header: actor + weapon, a subtitle of skill /
 *  damage types, a chip row of roll components, and the damage line (label,
 *  formula, and a button that rolls the damage). `damage` is
 *  { display, formula, types } — display is the human-readable formula
 *  ("2d6 ×2"), formula is the rollable expression ("(2d6)*2"). */
/** Enumerate an actor's active status effects whose roll mods touch the
 *  given bucket ("attack" or "defense"), and return one chip per relevant
 *  status with its capitalized name + signed value. Used to surface
 *  Prone / Blinded / Staggered / Exhausted / etc. on the attack card so
 *  the table can see what's contributing to the math.
 *
 *  Reads STATUS_CLAUSES via `mechanics/statusEngine.clauseFor` (imported
 *  at the top of the file). Includes any "all" bucket (Exhausted /
 *  Diseased) since those affect every roll. */
function breakdownStatusMods(actor, bucket) {
    const out = [];
    if (!actor?.statuses?.size) return out;
    for (const id of actor.statuses) {
        const clause = _clauseFor(id);
        const roll = clause?.mods?.roll;
        if (!roll) continue;
        const v = (Number(roll[bucket]) || 0) + (Number(roll.all) || 0);
        if (!v) continue;
        const name = id.charAt(0).toUpperCase() + id.slice(1);
        out.push({ label: name, value: signed(v) });
    }
    return out;
}

function attackRollFlavor({ actorName, weaponName, subtitle, chips = [], damage, qualities = [], qualityKeys = [], qualityValues = {}, note = "", hitLocation = null, weaponUuid = "" }) {
    const qualitiesHtml = qualities.length
        ? `<div class="wdm-attack-qualities"><span class="wdm-attack-qualities-k">${esc(game.i18n.localize("WITCHER.Attack.Qualities"))}</span> ${esc(qualities.join(", "))}</div>`
        : "";
    const noteHtml = note
        ? `<div class="wdm-attack-note"><i class="fa-solid fa-circle-info"></i> ${esc(note)}</div>`
        : "";
    /* Hit location gets PROMOTED out of the chips row — it's the most
     * gameplay-relevant single piece of info on an attack card (drives
     * damage ×3 head / ×½ limb plus crit-wound region). Rendered as a
     * dedicated, larger block with a bullseye icon. */
    const hitLocHtml = hitLocation?.label
        ? `<div class="wdm-attack-hit-loc"><i class="fa-solid fa-bullseye"></i>` +
              `<span class="wdm-attack-hit-loc-k">Hit Location</span>` +
              `<span class="wdm-attack-hit-loc-v">${esc(hitLocation.label)}</span>` +
              (hitLocation.multLabel ? `<span class="wdm-attack-hit-loc-mult">${esc(hitLocation.multLabel)}</span>` : "") +
          `</div>`
        : "";
    const chipHtml = chips
        .filter(c => c && c.value != null && c.value !== "")
        .map(c => `<span class="wdm-chip"><span class="wdm-chip-k">${esc(c.label)}</span><span class="wdm-chip-v">${esc(c.value)}</span></span>`)
        .join("");
    const locMult = Number(damage?.locMult) || 1;
    const locNote = (damage?.display && locMult !== 1)
        ? `<div class="wdm-attack-damage-note">${esc(game.i18n.localize("WITCHER.Attack.SubtractSP"))} ×${esc(locMult)}${damage.locLabel ? ` (${esc(damage.locLabel)})` : ""}</div>`
        : "";
    /* Quality payload — serialized in full so BOTH the damage-pipeline
     * (AP / Improved AP / Ablating / Silver flags on the GM side) AND the
     * post-hit rider logic (Bleeding / Stun / etc.) can filter it. */
    const qKeys      = Array.isArray(qualityKeys) ? qualityKeys : [];
    const qValues    = qualityValues && typeof qualityValues === "object" ? qualityValues : {};
    const qualAttr   = qKeys.length
        ? ` data-qualities="${esc(JSON.stringify(qKeys))}" data-quality-values="${esc(JSON.stringify(qValues))}"`
        : "";
    const locKey     = damage?.locKey ?? "";
    const locKeyAttr = locKey ? ` data-loc-key="${esc(locKey)}"` : "";
    /* Silver-quality damage formula (hybrid steel/silver-inlay weapons) — the
     * button holds it as a separate attribute; the click handler rolls it on
     * top of the base when the target carries the resistNonSilver flag (RAW:
     * the base portion gets halved, the silver portion doesn't, summed). */
    const silverAttr = damage?.silverFormula ? ` data-silver-formula="${esc(damage.silverFormula)}"` : "";
    /* Weapon UUID — propagated to the damage button so the GM-side
     * handleApplyDamage can look up the attacking weapon's appliedOil
     * snapshot and fold the oil's bonus damage when the target's
     * monster category matches the oil's authored target. Empty string
     * for non-weapon attacks (none currently, but kept defensive). */
    const weaponUuidAttr = weaponUuid ? ` data-weapon-uuid="${esc(weaponUuid)}"` : "";
    /* Raw damage-type KEYS (untranslated: "slashing", "piercing", "fire").
     * The calculator matches these against armor DR / monster resist /
     * immunity / vulnerability lists — which are all keyed by raw names.
     * `data-types` still carries the localized display string for the
     * chat card, but the damage roll uses THIS attribute to build the
     * actual damageTypes array so resistances land under any locale. */
    const typeKeys   = Array.isArray(damage?.typeKeys) ? damage.typeKeys : [];
    const typeKeysAttr = typeKeys.length
        ? ` data-type-keys="${esc(JSON.stringify(typeKeys))}"`
        : "";

    const damageHtml = damage?.display ? `
        <div class="wdm-attack-damage">
            <span class="wdm-attack-damage-k">${esc(game.i18n.localize("WITCHER.Attack.Damage"))}</span>
            <span class="wdm-attack-damage-v">${esc(damage.display)}</span>
            ${damage.formula ? `<button type="button" class="wdm-attack-damage-roll" data-action="wdm-roll-damage" data-formula="${esc(damage.formula)}" data-types="${esc(damage.types ?? "")}"${typeKeysAttr} data-loc-mult="${esc(locMult)}" data-loc-label="${esc(damage.locLabel ?? "")}" data-strike="${esc(damage.strike ?? "normal")}"${locKeyAttr}${qualAttr}${silverAttr}${weaponUuidAttr}><i class="fa-solid fa-burst"></i> ${esc(game.i18n.localize("WITCHER.Attack.RollDamage"))}</button>` : ""}
        </div>${locNote}` : "";
    return `
        <div class="wdm-skill-head wdm-attack-head">
            <div class="wdm-skill-actor">${esc(actorName)}</div>
            <div class="wdm-skill-name">${esc(weaponName)}</div>
            ${subtitle ? `<div class="wdm-skill-sub">${esc(subtitle)}</div>` : ""}
            ${qualitiesHtml}
            ${chipHtml ? `<div class="wdm-skill-chips">${chipHtml}</div>` : ""}
            ${hitLocHtml}
            ${damageHtml}
            ${noteHtml}
        </div>`;
}

/** Find the defense chat message linked to this attack via the engagement
 *  flag.  Returns its rolled defenseTotal or null if no defense was rolled
 *  (target chose "take it", or the attack predates the linkage). */
function lookupDefenseTotal(engagementId) {
    if (!engagementId || !game.messages) return null;
    for (const msg of game.messages) {
        const eng = msg.getFlag?.(SYSTEM_ID, "engagementId");
        if (eng === engagementId) {
            const dt = msg.getFlag(SYSTEM_ID, "defenseTotal");
            return Number.isFinite(Number(dt)) ? Number(dt) : null;
        }
    }
    return null;
}

/** Parse the JSON quality payload stuffed into the damage button's data
 *  attributes by attackRollFlavor.  Safe against malformed JSON.  Returns
 *  the FULL quality set — callers filter as they need (the calculator
 *  derives AP/Improved AP/Ablating from this; the rider logic filters by
 *  QUALITY_RIDERS). */
function readQualityPayload(btn) {
    let keys = [], values = {};
    try { keys   = JSON.parse(btn?.dataset?.qualities      ?? "[]"); } catch { /* ignore */ }
    try { values = JSON.parse(btn?.dataset?.qualityValues  ?? "{}"); } catch { /* ignore */ }
    if (!Array.isArray(keys)) keys = [];
    if (!values || typeof values !== "object") values = {};
    return { keys, values };
}

/** Friendly display name for a status id — looks up CONFIG.statusEffects
 *  for a localized label, falls back to title-casing the id. Used in the
 *  collapsed summary one-liner ("torso · 6 dmg · Bleed · Burning"). */
function statusDisplayName(statusId) {
    const def = (CONFIG.statusEffects ?? []).find(s => s.id === statusId);
    const raw = def?.name ? game.i18n.localize(def.name) : null;
    if (raw && !raw.startsWith("WITCHER.")) return raw;
    return String(statusId ?? "").replace(/^./, c => c.toUpperCase());
}

/** Fire post-hit quality riders on a target.  Reads each quality's rider
 *  config from the active catalog (data-driven via the Qualities Editor),
 *  so adding / retargeting a rider is a settings change, not a code edit.
 *
 *  When `opts.attackMessageUuid` is provided, each rider's chat output
 *  folds INTO the attack message's collapsible damage-result block
 *  instead of posting standalone chat messages — user spec: "no
 *  separate messages for the status effects application and shit".
 *  Without it (legacy callers / damage outside an attack flow), the
 *  prior standalone-message behavior is preserved.
 *
 *  Returns the list of chat lines describing what fired. */
export async function applyQualityRiders(target, qualityKeys, qualityValues, locKey, speaker, opts = {}) {
    const lines = [];
    const attackMsg = opts.attackMessageUuid ? await fromUuid(opts.attackMessageUuid) : null;

    /* Helper — either fold into the attack card's <details>, or post
     * standalone. summaryAdd lands on the result block's one-liner. */
    const emit = async (fragment, summaryAdd) => {
        if (attackMsg) {
            await appendAttackResult(attackMsg, { fragment, summaryAdd });
        } else {
            await ChatMessage.create({
                speaker,
                content: fragment,
                flags: { [SYSTEM_ID]: { category: "combat" } }
            });
        }
    };

    for (const key of qualityKeys) {
        const rider = riderForQuality(key);
        if (!rider || !rider.statusId) continue;
        const locations = rider.locations && rider.locations.length
            ? rider.locations
            : (rider.kind === "stunSave" ? DEFAULT_STUN_LOCATIONS : null);
        if (locations && !locations.includes(locKey)) continue;

        if (rider.kind === "auto") {
            try {
                await emitApplyStatus({ targetUuid: target.uuid, statusId: rider.statusId, action: "apply" });
                const label = statusDisplayName(rider.statusId);
                const frag = `<div class="wdm-attack-rider"><i class="fa-solid fa-droplet"></i> <strong>${esc(label)}</strong> applied <span class="wdm-attack-rider-src">(${esc(key)})</span></div>`;
                await emit(frag, { label: `${target.name}: ${label}`, kind: "status", icon: "fa-droplet" });
                lines.push(`${target.name}: ${label} applied (${key})`);
            } catch (err) {
                console.warn(`witcher-ttrpg-death-march | apply ${rider.statusId} to ${target.name} failed`, err);
            }
            continue;
        }

        if (rider.kind === "percent") {
            let pct = Math.max(0, Math.min(100, Number(qualityValues?.[key]) || 0));
            /* ── Phase 8 — Bleed Resistance armor (EO p.8) ───────────
             * When the rider applies the `bleed` status, REDUCE the %
             * chance by every equipped armor piece's `bleedResistance`
             * value on the defender. Armor parameter convention: the
             * value is the MAGNITUDE (e.g. "25" → -25%). */
            if (rider.statusId === "bleed" && target?.items?.filter) {
                const wornDef = target.items.filter(i =>
                    i.type === "armor" && i.system?.equipped);
                let resist = 0;
                for (const a of wornDef) {
                    const qs = a.system?.effective?.qualities ?? a.system?.qualities ?? [];
                    if (!qs.includes("bleedResistance")) continue;
                    const wVals = a.system?.effective?.qualityValues ?? a.system?.qualityValues ?? {};
                    const v = Number(wVals.bleedResistance);
                    if (Number.isFinite(v) && v > 0) resist += v;
                }
                if (resist > 0) pct = Math.max(0, pct - resist);
            }
            if (pct <= 0) continue;
            const roll = await new Roll("1d100").evaluate();
            const hit  = roll.total <= pct;
            const label = statusDisplayName(rider.statusId);
            const dieRender = await roll.render();
            const rollLine =
                `<div class="wdm-attack-rider ${hit ? "is-hit" : "is-miss"}">` +
                    `<i class="fa-solid ${hit ? "fa-droplet" : "fa-droplet-slash"}"></i> ` +
                    `<strong>${esc(label)}</strong> rider · ` +
                    `<span class="wdm-attack-rider-roll">${roll.total} / ${pct}%</span> · ` +
                    `<em>${hit ? "applies" : "no effect"}</em>` +
                    `<details class="wdm-attack-rider-detail"><summary>roll detail</summary>${dieRender}</details>` +
                `</div>`;
            await emit(rollLine, hit ? { label: `${target.name}: ${label}`, kind: "status", icon: "fa-droplet" } : "");
            if (hit) {
                try {
                    await emitApplyStatus({ targetUuid: target.uuid, statusId: rider.statusId, action: "apply" });
                    lines.push(`${target.name}: ${label} applied (${key} ${pct}%)`);
                } catch (err) {
                    console.warn(`witcher-ttrpg-death-march | apply ${rider.statusId} to ${target.name} failed`, err);
                }
            }
            continue;
        }

        if (rider.kind === "stunSave") {
            const modifier = parseInt(String(qualityValues?.[key] ?? "0"), 10) || 0;
            const frag =
                `<div class="wdm-stun-prompt">` +
                    `<em>${esc(target.name)} — ${esc(key)} hit (${esc(locKey)})` +
                    (modifier ? `, save at ${signed(modifier)}` : "") + `.</em>` +
                    `<button type="button" data-action="wdm-stun-save"` +
                    ` data-target-uuid="${esc(target.uuid)}"` +
                    ` data-stun-mod="${esc(modifier)}">` +
                    `<i class="fa-solid fa-dice-d10"></i> Roll Stun Save</button>` +
                `</div>`;
            await emit(frag, {
                label: `${target.name}: Stun save${modifier ? ` ${signed(modifier)}` : ""}`,
                kind: "status",
                icon: "fa-dice-d10"
            });
            lines.push(`${target.name}: Stun save prompted (${signed(modifier)})`);
        }
    }
    return lines;
}

/** Roll a damage card from a clicked attack-card button. Reuses the source
 *  message's speaker so the damage is attributed to the attacker. If the
 *  user has any tokens TARGETED at click time, the rolled total is also
 *  applied to each target's HP via the GM-proxied damage socket — armor
 *  SP and location math is NOT subtracted at this layer (the GM can fix
 *  up via the sheet if needed). Surfaces a per-target notification and a
 *  follow-up chat line so the application is visible. */
async function rollDamageFromButton(btn) {
    const formula = btn?.dataset?.formula;
    if (!formula) return;
    /* Silver-portion formula (Silver-quality weapons). Rolled alongside the
     * base; the GM-side calculator decides per-target whether to fold it in
     * (target with resistNonSilver → base/2 + silver; otherwise silver is
     * ignored). Empty / unset → no silver portion, nothing extra rolled. */
    const silverFormula = String(btn?.dataset?.silverFormula ?? "").trim();
    /* One-shot: damage rolls only once per action button. Mark the
     * button consumed up-front so a double-click can't fire twice
     * even before the chat re-render replaces it. The render hook
     * also strips any further wdm-roll-damage buttons from the
     * message content below. */
    if (btn.dataset.consumed === "1") return;
    btn.dataset.consumed = "1";
    btn.disabled = true;
    const li  = btn.closest("[data-message-id]");
    const msg = li ? game.messages.get(li.dataset.messageId) : null;
    const speaker = msg?.speaker ?? ChatMessage.getSpeaker();
    const types = btn.dataset.types || "";
    /* Raw type keys stamped on the button by attackRollFlavor. Preferred
     * over the localized `types` string for downstream damage math —
     * resistance / immunity / vulnerability lists in the calculator are
     * all keyed by raw names ("slashing", "fire", …), and the label
     * round-trip only works in English. */
    const typeKeysRaw = (() => {
        try {
            const arr = JSON.parse(btn.dataset.typeKeys || "[]");
            return Array.isArray(arr) ? arr.map(String).filter(Boolean) : [];
        } catch (_) { return []; }
    })();
    const locMult = Number(btn.dataset.locMult) || 1;
    const locLabel = btn.dataset.locLabel || "";

    /* Crit detection — prefer the severity the verdict-patch stamped onto
     * the attack message at resolve time (engagement-linked defense rolls
     * are suppressed and never post a standalone card, so a flag scan via
     * lookupDefenseTotal returns null for them). Fall back to lookup +
     * recompute for legacy attack cards that predate the flag stamping. */
    const engagementId = msg?.getFlag?.(SYSTEM_ID, "engagementId") ?? "";
    const attackTotal  = Number(msg?.getFlag?.(SYSTEM_ID, "attackTotal"));
    const stampedSev   = msg?.getFlag?.(SYSTEM_ID, "critSeverity") ?? null;
    let defenseTotal   = Number(msg?.getFlag?.(SYSTEM_ID, "defenseTotal"));
    if (!Number.isFinite(defenseTotal)) defenseTotal = engagementId ? lookupDefenseTotal(engagementId) : null;
    const delta = (Number.isFinite(attackTotal) && Number.isFinite(defenseTotal))
        ? (attackTotal - defenseTotal) : null;
    const critSeverity = stampedSev ?? (delta != null ? critSeverityFromDelta(delta) : null);
    try {
        const roll = await new Roll(formula).evaluate();
        /* Silver portion: rolled separately so the card can show the two
         * dice trays side-by-side. Whether it actually lands depends on
         * the target — the calculator folds it only against monsters with
         * resistNonSilver (RAW Core p.157). Against everything else it's
         * shown for transparency but ignored in the damage math. */
        const silverRoll  = silverFormula ? await new Roll(silverFormula).evaluate() : null;
        const silverTotal = silverRoll ? Number(silverRoll.total) || 0 : 0;
        const head = game.i18n.localize("WITCHER.Attack.Damage");
        const note = locMult !== 1
            ? `<div class="wdm-attack-damage-note">${esc(game.i18n.localize("WITCHER.Attack.SubtractSP"))} ×${esc(locMult)}${locLabel ? ` (${esc(locLabel)})` : ""}</div>`
            : "";

        /* Single-card consolidation: instead of posting a separate damage
         * card here, build the rolled-dice HTML and APPEND it to the attack
         * card. The breakdown + crit wound info that follow also append to
         * the same card (via attackMessageUuid in their payloads) so the
         * whole resolution lives in one place. */
        const diceHtml       = await roll.render();
        const silverDiceHtml = silverRoll ? await silverRoll.render() : "";
        /* Silver dice get their own labeled tray below the main damage, so
         * the table can read each portion. Note the conditional: this only
         * MATTERS vs. silver-resistant targets — labeled accordingly so a
         * player rolling a steel sword + silver inlay vs. a bandit sees
         * "Silver (vs. silver-resistant only)" and isn't confused that the
         * 12 isn't being added. The calculator does the right math. */
        const silverBlockHtml = silverRoll
            ? `<div class="wdm-attack-damage-silver">` +
                  `<div class="wdm-attack-damage-roll-head">` +
                      `${esc(game.i18n.localize("WITCHER.Attack.SilverDamage") || "Silver Damage")} ` +
                      `<span class="wdm-attack-damage-roll-types" style="opacity:0.7;">— applies only vs. silver-resistant</span>` +
                  `</div>` +
                  silverDiceHtml +
              `</div>`
            : "";
        const damageBlockHtml =
            `<div class="wdm-attack-damage-roll-block">` +
                `<div class="wdm-attack-damage-roll-head">${esc(head)}${types ? ` <span class="wdm-attack-damage-roll-types">— ${esc(types)}</span>` : ""}</div>` +
                note +
                diceHtml +
                silverBlockHtml +
            `</div>`;
        if (msg) {
            /* Fold the damage roll into the SINGLE collapsible attack
             * card. The damage button is also stripped from the card
             * content here — damage is one-shot per swing (user spec),
             * so the button shouldn't survive a successful roll. The
             * surrounding ".wdm-attack-damage" wrapper (which holds
             * the formula display + button) is removed as a unit. */
            const stamp = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
            const stampedBlock = damageBlockHtml.replace(
                'class="wdm-attack-damage-roll-block"',
                `class="wdm-attack-damage-roll-block" data-rolled-at="${stamp}"`
            );
            try {
                /* Strip the damage button — from BOTH places it lives:
                 *   1. The body's `.wdm-attack-damage` wrapper
                 *   2. The summary's action slot (`.wdm-card-sum-roll`)
                 * Also clear the wrapper's stored summaryAction data
                 * attribute so the next appendAttackResult call doesn't
                 * re-render the button into the summary slot. */
                const tmp = document.createElement("div");
                tmp.innerHTML = String(msg.content ?? "");
                tmp.querySelectorAll(".wdm-attack-damage").forEach(n => n.remove());
                tmp.querySelectorAll(".wdm-attack-damage-note").forEach(n => n.remove());
                tmp.querySelectorAll(".wdm-card-sum-roll").forEach(n => n.remove());
                tmp.querySelectorAll("details.wdm-attack-card").forEach(c => {
                    delete c.dataset.summaryActionHtml;
                });
                await msg.update({ content: tmp.innerHTML });
            } catch (err) {
                console.warn("witcher-ttrpg-death-march | strip damage button failed", err);
            }
            /* Pass summaryAction:"" so the appender clears the slot
             * (the previous data-attribute strip above takes care of
             * the storage; this matches it for the live render). */
            await appendAttackResult(msg, { fragment: stampedBlock, summaryAction: "" });
        }

        /* Damage targets: prefer real token targets; fall back to the
         * per-user tokenless actor-target flag (set via the combat-
         * tracker context menu) so theater-of-mind / no-scene fights
         * still apply damage to the right actor. Without this fallback,
         * a click on the Roll Damage button rolled dice but applied
         * nothing — the targets array came back empty. */
        /* Target resolution order for damage-apply:
         *   1. The `defenderUuid` flag stamped on the attack card by
         *      weaponAttack (always the resolved defender, incl. Riposte's
         *      `forceDefender`). This is AUTHORITATIVE — the attack
         *      already knows who it was aimed at, no need to re-derive
         *      from client state that may point at the wrong actor
         *      (e.g. defender's own combat-tracker target was themselves).
         *   2. Live canvas token target on the current user.
         *   3. Tokenless combat-tracker target (per-user actorTargetUuid). */
        let targets = [];
        try {
            const stampedDefUuid = msg?.getFlag?.(SYSTEM_ID, "defenderUuid");
            if (stampedDefUuid) {
                const stamped = await fromUuid(stampedDefUuid);
                if (stamped) targets = [stamped];
            }
        } catch (_) { /* no stamped defender */ }
        if (!targets.length) {
            targets = Array.from(game.user?.targets ?? [])
                .map(t => t?.actor)
                .filter(a => !!a);
        }
        if (!targets.length) {
            try {
                const tokenlessTarget = await getActorTarget();
                if (tokenlessTarget) targets = [tokenlessTarget];
            } catch (_) { /* no actor-target flag set */ }
        }
        /* Witchers Reborn — Manticore · Stand Aside: if a Manticore
         * clicked the rider on this attack card, damage-apply lands on
         * THEM instead of the original defender. Stamped on the message
         * as `flags.wr.standAsideTarget = manticoreUuid`. Damage location
         * / attack roll are unchanged — the Manticore "eats" whatever
         * would have hit the ally. */
        try {
            const standAsideUuid = msg?.getFlag?.(SYSTEM_ID, "wr.standAsideTarget");
            if (standAsideUuid) {
                const rerouted = await fromUuid(standAsideUuid);
                if (rerouted) targets = [rerouted];
            }
        } catch (_) { /* flag missing / stale */ }
        /* Stand Aside successful defense: the Manticore parried/blocked/
         * dodged the redirected attack. No damage lands on anyone —
         * drop the targets list so the damage roll below is skipped. */
        if (msg?.getFlag?.(SYSTEM_ID, "wr.standAsideDefended")) {
            targets = [];
        }
        const isDamaging = Number.isFinite(roll.total) && roll.total > 0;
        if (targets.length && isDamaging) {
            const { keys: qualityKeys, values: qualityValues } = readQualityPayload(btn);
            const locKey = btn.dataset.locKey || "";
            /* Weapon UUID for the oil bonus damage fold on the GM side.
             * Stamped on the damage button by attackRollFlavor; pulled
             * here and passed through emitApplyDamage so handleApplyDamage
             * can look up `weapon.system.appliedOil` without relying on
             * the attack message's `system.weaponUuid` (which the existing
             * extendedRoll path never populates). */
            const weaponUuid = btn.dataset.weaponUuid || "";
            /* Strike-status rider: if the strike carries `appliesStatus`
             * (e.g. RAW Trip → prone), a hit lands the status. Rolling
             * damage IS the hit-confirmed moment — the verdict block on
             * the initial roll may not have run when the target had no
             * owner-driven defense (static/inanimate/no-defender paths),
             * so we apply here regardless of that block's state.
             * Hold ids (grappled/pinned/clinched/chokeheld) route through
             * applyHoldLink so both actors get the paired status. */
            const strikeKey = btn.dataset.strike || "";
            const strikeMeta = STRIKE_TYPES?.[strikeKey] ?? null;
            const strikeAppliesStatus = strikeMeta?.appliesStatus ?? null;
            for (const actor of targets) {
                try {
                    // AWAIT so the breakdown + rider applies finish before
                    // we move to the next target (and so the audit can read
                    // the resulting actor state without racing).
                    await emitApplyDamage({
                        targetUuid:        actor.uuid,
                        weaponDamage:      roll.total,
                        silverDamage:      silverTotal,
                        damageTypes:       typeKeysRaw.length
                            ? typeKeysRaw
                            : (types ? types.toLowerCase().split(/[\s·,/]+/).filter(Boolean) : []),
                        locationKey:       locKey,
                        locationLabel:     locLabel,
                        qualities:         qualityKeys,
                        qualityValues,
                        critSeverity,
                        weaponUuid,
                        attackMessageUuid: msg?.uuid ?? null
                    });
                } catch (err) {
                    console.warn(`witcher-ttrpg-death-march | apply damage to ${actor.name} failed`, err);
                }
                if (strikeAppliesStatus && actor?.uuid) {
                    const sid = String(strikeAppliesStatus);
                    const HOLDS = ["grappled", "pinned", "clinched", "chokeheld"];
                    try {
                        if (HOLDS.includes(sid)) {
                            const attackerActor = speaker?.actor ? game.actors?.get?.(speaker.actor) : null;
                            if (attackerActor) {
                                const { applyHoldLink } = await import("../../mechanics/holdLink.mjs");
                                await applyHoldLink(attackerActor, actor, sid);
                            }
                        } else {
                            await emitApplyStatus({ targetUuid: actor.uuid, statusId: sid, action: "apply" });
                        }
                        if (msg?.uuid) {
                            const statusDef = (CONFIG.statusEffects ?? []).find(s => s.id === sid);
                            const statusLabel = statusDef?.name ? game.i18n.localize(statusDef.name) : sid;
                            await appendAttackResult(msg, {
                                fragment: `<div class="wdm-attack-rider"><i class="fa-solid fa-link"></i> <strong>${esc(actor.name)}</strong> is now <strong>${esc(statusLabel)}</strong>.</div>`,
                                summaryAdd: { label: `${actor.name}: ${statusLabel}`, kind: "status", icon: "fa-link" }
                            });
                        }
                    } catch (err) {
                        console.warn(`witcher-ttrpg-death-march | strike-status ${sid} apply to ${actor.name} failed`, err);
                    }
                }
                /* Riders moved into handleApplyDamage so they fire once per
                 * damage event regardless of trigger source (damage button
                 * here, GM dock auto-apply, future scripted damage). */
            }

            /* Forceful Blow's rider is emitted BEFORE damage rolls now
             * (in the attack-verdict pass) so the button appears next to
             * Roll Damage. Clicking it debits 5 STA and rolls damage
             * twice, keeping the higher total. See the verdict pass in
             * this file (~line 2560). */
        }
    } catch (err) {
        console.error("witcher-ttrpg-death-march | damage roll failed", err);
        ui.notifications?.error("Damage roll failed — see console.");
    }
}

/** Roll a Stun save on a target from a Stun-quality prompt button. The
 *  click runs on the target's owner's client; we resolve the target by
 *  uuid and call its `rollStunSave` (saveMixin) which handles the dice,
 *  chat card, and "stunned" status application on a fail. */
async function rollStunSaveFromButton(btn) {
    const uuid = btn?.dataset?.targetUuid;
    const mod  = parseInt(btn?.dataset?.stunMod ?? "0", 10) || 0;
    if (!uuid) return;
    const target = await fromUuid(uuid);
    const actor  = target?.actor ?? target;
    if (!actor?.rollStunSave) {
        ui.notifications?.warn("Cannot roll Stun save for that target.");
        return;
    }
    btn.disabled = true;
    try { await actor.rollStunSave({ modifier: mod }); }
    catch (err) {
        console.error("witcher-ttrpg-death-march | stun save failed", err);
        ui.notifications?.error("Stun save failed — see console.");
        btn.disabled = false;
    }
}

/** Wire the attack-card damage button + the Stun-save prompt button. Called
 *  once during setup. */
export function installAttackChatHandlers() {
    Hooks.on("renderChatMessageHTML", (msg, el) => {
        /* Damage button can live in TWO places now:
         *   1. In the card body's .wdm-attack-damage wrapper (legacy)
         *   2. In the card summary's action slot (.wdm-card-sum-roll)
         * Wire BOTH — and add stopPropagation on the summary copy so
         * clicking it doesn't ALSO toggle the parent <details>. */
        const btns = el.querySelectorAll?.('button[data-action="wdm-roll-damage"]') ?? [];
        const sp = msg?.speaker ?? {};
        const attackerActor = sp.actor ? game.actors?.get?.(sp.actor)
                            : sp.token ? game.scenes?.get?.(sp.scene)?.tokens?.get?.(sp.token)?.actor
                            : null;
        const isAttacker = !!attackerActor?.isOwner;
        const isGM       = !!game.user?.isGM;
        for (const btn of btns) {
            if (!isAttacker && !isGM) {
                btn.remove();
                continue;
            }
            if (btn.dataset.wired) continue;
            btn.dataset.wired = "1";
            btn.addEventListener("click", (e) => {
                e.stopPropagation();
                /* Don't preventDefault — the button's own click still
                 * fires for keyboard activation etc. */
                rollDamageFromButton(btn);
            });
        }
        const stunBtn = el.querySelector?.('button[data-action="wdm-stun-save"]');
        if (stunBtn && !stunBtn.dataset.wired) {
            stunBtn.dataset.wired = "1";
            stunBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                rollStunSaveFromButton(stunBtn);
            });
        }
        /* Witchers Reborn — Forceful Blow rider button. Only the attacker
         * (or GM) sees it interactive; other clients get it stripped so
         * they can't spend the attacker's STA. */
        const fbBtn = el.querySelector?.('button[data-action="wdm-forceful-blow"]');
        if (fbBtn) {
            if (!isAttacker && !isGM) {
                fbBtn.closest(".wdm-wr-rider")?.remove();
            } else if (!fbBtn.dataset.wired) {
                fbBtn.dataset.wired = "1";
                fbBtn.addEventListener("click", (e) => {
                    e.stopPropagation();
                    rollForcefulBlowDamageFromButton(fbBtn, msg);
                });
            }
        }
        /* Witchers Reborn — Pirouette rider on feint chat cards. Same
         * ownership gate as Forceful Blow (only the attacker or GM sees
         * it interactive). */
        const pirBtn = el.querySelector?.('button[data-action="wdm-pirouette"]');
        if (pirBtn) {
            if (!isAttacker && !isGM) {
                pirBtn.closest(".wdm-wr-rider")?.remove();
            } else if (!pirBtn.dataset.wired) {
                pirBtn.dataset.wired = "1";
                pirBtn.addEventListener("click", (e) => {
                    e.stopPropagation();
                    rollPirouetteFromButton(pirBtn, msg);
                });
            }
        }
        /* Witchers Reborn — Deadly Focus rider on the attack card. Fires
         * BEFORE the damage button — clicking updates the message's
         * critSeverity flag so the subsequent damage roll picks up the
         * upgraded +N crit bonus. */
        const dfBtn = el.querySelector?.('button[data-action="wdm-deadly-focus"]');
        if (dfBtn) {
            if (!isAttacker && !isGM) {
                dfBtn.closest(".wdm-wr-rider")?.remove();
            } else if (!dfBtn.dataset.wired) {
                dfBtn.dataset.wired = "1";
                dfBtn.addEventListener("click", (e) => {
                    e.stopPropagation();
                    upgradeDeadlyFocusFromButton(dfBtn, msg);
                });
            }
        }
        /* Witchers Reborn — Manticore · Riposte riders. Defender-side
         * buttons (the shield-parrier's owner). Multiple buttons may
         * exist on the same card (Bash + Strike-with-weapon); ownership
         * gate strips the WHOLE rider from non-owners so they can't
         * spend someone else's STA or trigger the strike. */
        const ripBtns = el.querySelectorAll?.('button[data-action="wdm-riposte-strike"]') ?? [];
        if (ripBtns.length) {
            const first = ripBtns[0];
            const defActorUuid = first.dataset?.actorUuid ?? "";
            let defActor = null;
            try { defActor = defActorUuid ? fromUuidSync(defActorUuid) : null; } catch (_) { defActor = null; }
            const isDefender = !!defActor?.isOwner;
            if (!isDefender && !isGM) {
                first.closest(".wdm-wr-rider")?.remove();
            } else {
                for (const btn of ripBtns) {
                    if (btn.dataset.wired) continue;
                    btn.dataset.wired = "1";
                    btn.addEventListener("click", (e) => {
                        e.stopPropagation();
                        applyRiposteStrikeFromButton(btn);
                    });
                }
            }
        }
        /* Witchers Reborn — Manticore · Stand Aside: inject the redirect
         * rider button when the current user owns a Manticore with the
         * "standAside" heroic, that Manticore is adjacent (Chebyshev ≤ 1
         * tile) to the declared defender, and the rider hasn't been used
         * yet on this attack. Injection happens per-client on render so
         * different Manticores' owners can each see their own eligibility.
         *
         * Idempotent: bail if a button is already present in the DOM. */
        try {
            const alreadyInjected = !!el.querySelector?.('button[data-action="wdm-stand-aside"]');
            const alreadyUsed = !!msg?.getFlag?.(SYSTEM_ID, "wr.standAsideTarget")
                || !!msg?.getFlag?.(SYSTEM_ID, "wr.standAsideDefended");
            const defUuid = msg?.getFlag?.(SYSTEM_ID, "defenderUuid");
            const attackerUuid = msg?.getFlag?.(SYSTEM_ID, "attackerUuid");
            if (!alreadyInjected && !alreadyUsed && defUuid && !msg?.getFlag?.(SYSTEM_ID, "feintSummary")) {
                const defender = fromUuidSync?.(defUuid);
                const defTok = defender?.getActiveTokens?.()?.[0];
                if (defender && defTok) {
                    /* Find any owned Manticore with the heroic + AE + STA
                     * that's adjacent to the defender on the same scene.
                     * Excludes the attacker themselves (a Manticore can't
                     * Stand Aside to protect their OWN attack's target —
                     * you're already the one swinging) and any Manticore
                     * currently targeting the defender (same reasoning:
                     * if you're queued to hit them, you're not going to
                     * leap in front). */
                    const eligible = findStandAsideCandidates(defender, defTok, attackerUuid);
                    if (eligible.length) {
                        const cand = eligible[0]; // first eligible owned candidate
                        const cardBody = el.querySelector?.(".message-content") ?? el;
                        const div = document.createElement("div");
                        div.className = "wdm-attack-rider wdm-wr-rider";
                        div.dataset.wrRider = "standAside";
                        div.innerHTML =
                            `<i class="fa-solid fa-shield-heart"></i> ` +
                            `<strong>Stand Aside</strong> — ` +
                            `${esc(cand.actor.name)} may leap in front of ${esc(defender.name)} (1 adrenaline). ` +
                            `<button type="button" class="wdm-attack-damage-roll" data-action="wdm-stand-aside" ` +
                                `data-actor-uuid="${esc(cand.actor.uuid)}" ` +
                                `data-msg-uuid="${esc(msg?.uuid ?? "")}" ` +
                                `data-defender-uuid="${esc(defUuid)}">` +
                                `Stand Aside — spend 1 adrenaline` +
                            `</button>`;
                        cardBody.appendChild(div);
                    }
                }
            }
            const saBtn = el.querySelector?.('button[data-action="wdm-stand-aside"]');
            if (saBtn && !saBtn.dataset.wired) {
                saBtn.dataset.wired = "1";
                saBtn.addEventListener("click", (e) => {
                    e.stopPropagation();
                    applyStandAsideFromButton(saBtn);
                });
            }
        } catch (err) {
            console.warn("witcher-ttrpg-death-march | Stand Aside rider inject failed", err);
        }
        /* Charge → knock-prone rider (RAW Core): opposed Physique vs
         * Physique after a blocked charge. Attacker-only button (GM
         * sees it too for player NPCs); non-owners get it stripped. */
        const cpBtn = el.querySelector?.('button[data-action="wdm-charge-prone"]');
        if (cpBtn) {
            if (!isAttacker && !isGM) {
                cpBtn.closest("[data-charge-rider]")?.remove();
            } else if (!cpBtn.dataset.wired) {
                cpBtn.dataset.wired = "1";
                cpBtn.addEventListener("click", (e) => {
                    e.stopPropagation();
                    rollChargeProneFromButton(cpBtn, msg);
                });
            }
        }
    });
}

/** Charge → knock-prone opposed check (RAW Core Charge rider).
 *  Fires when the attacker clicks the button on a blocked charge card.
 *  Rolls 1d10 + Physique for BOTH sides on the attacker's client and
 *  compares totals. On attacker win, applies `prone` to the defender
 *  via emitApplyStatus (GM-side routing so the write lands even when
 *  the attacker is a player who can't touch the defender's flags).
 *  Both rolls post to chat as a single verdict card so the table sees
 *  the math. The button is consumed on first click to prevent a
 *  double-apply. */
async function rollChargeProneFromButton(btn, msg) {
    if (btn?.dataset?.consumed === "1") return;
    const attackerUuid = btn?.dataset?.attackerUuid;
    const targetUuid   = btn?.dataset?.targetUuid;
    if (!attackerUuid || !targetUuid) {
        ui.notifications?.warn?.("Charge prone: missing actor references.");
        return;
    }
    const attacker = await fromUuid(attackerUuid);
    const target   = await fromUuid(targetUuid);
    if (!attacker || !target) return;
    btn.dataset.consumed = "1";
    btn.disabled = true;

    const readPhysique = (a) => {
        /* Physique is a Body-stat skill (RAW). Uses the cached derived
         * total via _readSkillValues to include stat + skill + mod. */
        const sv = a._readSkillValues?.("physique");
        if (sv) return sv;
        /* Fallback: bare BODY value if the skill isn't set up. */
        const stat = Number(a.system?.stats?.body?.value) || 0;
        return { statVal: stat, skillVal: 0, skillMod: 0, total: stat, meta: { statKey: "body", skillKey: "physique" } };
    };

    const aP = readPhysique(attacker);
    const dP = readPhysique(target);

    try {
        const aRoll = await (new Roll(aP.total ? `1d10 + ${aP.total}` : `1d10`)).evaluate();
        const dRoll = await (new Roll(dP.total ? `1d10 + ${dP.total}` : `1d10`)).evaluate();
        const aTotal = Number(aRoll.total) || 0;
        const dTotal = Number(dRoll.total) || 0;
        const attackerWins = aTotal > dTotal;

        if (attackerWins) {
            try {
                await emitApplyStatus({ targetUuid: target.uuid, statusId: "prone", action: "apply" });
            } catch (err) {
                console.warn("witcher-ttrpg-death-march | charge prone status apply failed", err);
            }
        }

        const verdict = attackerWins
            ? `<div style="color:#4a4"><b>${esc(target.name)}</b> is knocked prone.</div>`
            : `<div style="color:#a44"><b>${esc(target.name)}</b> keeps their footing.</div>`;
        const fragment =
            `<div class="wdm-attack-rider">` +
                `<i class="fa-solid fa-person-falling"></i> ` +
                `<strong>Charge → Prone</strong>: ` +
                `<b>${esc(attacker.name)}</b> ${aTotal} vs <b>${esc(target.name)}</b> ${dTotal}. ${verdict}` +
            `</div>`;
        if (msg) {
            try {
                /* Strip the trigger button so it can't be clicked again on
                 * a re-render even after `consumed = "1"` (a fresh DOM
                 * from message re-render would lose the dataset). */
                const tmp = document.createElement("div");
                tmp.innerHTML = String(msg.content ?? "");
                tmp.querySelectorAll('[data-charge-rider]').forEach(n => n.remove());
                await msg.update({ content: tmp.innerHTML });
            } catch (_) { /* renderer already replaced content */ }
            await appendAttackResult(msg, {
                fragment,
                summaryAdd: {
                    label: attackerWins ? "Charge: target proned" : "Charge: prone attempt failed",
                    kind:  attackerWins ? "hit" : "miss",
                    icon:  "fa-person-falling"
                }
            });
        }
    } catch (err) {
        console.warn("witcher-ttrpg-death-march | charge prone roll failed", err);
        ui.notifications?.warn?.("Charge prone: roll failed.");
    }
}

/** CE Bash post-hit outcome. The Brawling attack roll already landed;
 *  this rolls opposed 1d10 + Physique on both sides. Defender adds their
 *  equipped shield's Cover Value if any. On attacker win: push the
 *  defender BODY/3 metres directly away from the attacker (walls clip
 *  via pushToken). On +7 delta over the defender: also apply Staggered.
 *  Both physique rolls fire on the attacker's client so the resolution
 *  auto-runs without waiting on the defender's owner — same
 *  simplification the Charge → Prone rider uses. */
async function autoRollBashOutcome(attacker, target, msg) {
    if (!attacker || !target) return;

    const readPhysique = (a) => {
        const sv = a._readSkillValues?.("physique");
        if (sv) return sv;
        const stat = Number(a.system?.stats?.body?.value) || 0;
        return { total: stat };
    };

    /* Sum the Cover Value of every equipped shield an actor is
     * wielding. A bash contest is a shove — whether you're initiating
     * or bracing against one, a shield in-hand gives you leverage, so
     * BOTH the attacker AND the defender add their own shield CV to
     * their Physique roll. */
    const readShieldCV = (a) => (a?.items ?? [])
        .filter(i => i?.type === "shield" && i?.system?.equipped)
        .reduce((sum, sh) => sum + (Number(sh.system?.coverValue) || 0), 0);
    const aShieldCV = readShieldCV(attacker);
    const dShieldCV = readShieldCV(target);

    const aP = readPhysique(attacker);
    const dP = readPhysique(target);
    const aTotalBase = Number(aP?.total) || 0;
    const dTotalBase = Number(dP?.total) || 0;

    try {
        /* Both formulas keep Physique and Shield CV as SEPARATE addends
         * so the dice-tray renders "1d10 + Physique + CV" instead of a
         * pre-summed constant — the player can see exactly which portion
         * came from the shield when they hover the roll. */
        const buildFormula = (physique, cv) => {
            const parts = ["1d10"];
            if (physique !== 0) parts.push(String(physique));
            if (cv       !== 0) parts.push(String(cv));
            return parts.join(" + ");
        };
        const aRoll = await (new Roll(buildFormula(aTotalBase, aShieldCV))).evaluate();
        const dRoll = await (new Roll(buildFormula(dTotalBase, dShieldCV))).evaluate();
        const aTotal = Number(aRoll.total) || 0;
        const dTotal = Number(dRoll.total) || 0;
        const delta  = aTotal - dTotal;
        const attackerWins = delta > 0;
        const bigWin       = delta >= 7;

        let pushLine = "";
        let staggerLine = "";
        if (attackerWins) {
            /* Push BODY/2 metres directly away from the attacker's
             * token (floor). Fixed distance from the attacker's raw
             * BODY stat — same "1/N of your Physique base" pattern
             * used by RAW Push Kick, tuned tighter for a Bash. */
            try {
                const attackerBody = Number(attacker.system?.stats?.body?.value) || 0;
                const meters = Math.max(0, Math.floor(attackerBody / 2));
                const attackerToken = attacker.getActiveTokens?.()?.[0] ?? null;
                const targetToken   = target.getActiveTokens?.()?.[0] ?? null;
                if (meters > 0 && attackerToken && targetToken?.document?.uuid) {
                    const sourcePoint = {
                        x: Number(attackerToken.center?.x ?? attackerToken.x),
                        y: Number(attackerToken.center?.y ?? attackerToken.y)
                    };
                    const { emitPushToken } = await import("../../setup/socketHook.mjs");
                    const res = await emitPushToken({
                        tokenUuid:       targetToken.document.uuid,
                        sourcePoint,
                        distanceMeters:  meters
                    });
                    const moved = Number(res?.moved) || 0;
                    const wall  = res?.hitWall ? " — cut short against a wall" : "";
                    const shown = moved > 0 ? `${moved.toFixed(1)}m` : `${meters}m`;
                    pushLine = `<div style="color:#4a4"><b>${esc(target.name)}</b> is pushed <b>${esc(shown)}</b> (BODY ${attackerBody}/2 = ${meters})${esc(wall)}.</div>`;
                } else if (meters > 0) {
                    pushLine = `<div style="color:#4a4"><b>${esc(target.name)}</b> is pushed <b>${meters}m</b> back (no scene token — apply manually).</div>`;
                }
            } catch (err) {
                console.warn("witcher-ttrpg-death-march | bash push failed", err);
            }

            if (bigWin) {
                try {
                    await emitApplyStatus({ targetUuid: target.uuid, statusId: "staggered", action: "apply" });
                    staggerLine = `<div style="color:#a84"><b>${esc(target.name)}</b> is <b>Staggered</b> (delta ${delta}).</div>`;
                } catch (err) {
                    console.warn("witcher-ttrpg-death-march | bash stagger apply failed", err);
                }
            }
        }

        const verdictHead = attackerWins
            ? `<div style="color:#4a4"><b>${esc(attacker.name)}</b> wins the shove.</div>`
            : `<div style="color:#a44"><b>${esc(target.name)}</b> holds ground.</div>`;
        /* Render both physique rolls so the dice tray shows d10 + each
         * addend separately. Each header lists Physique and Shield CV
         * as visible terms — a Shield CV chip only appears when that
         * side actually has an equipped shield contributing bonus. */
        const aDiceHtml = await aRoll.render();
        const dDiceHtml = await dRoll.render();
        const aCvTail = aShieldCV > 0 ? ` <span style="opacity:0.75;">(+${aShieldCV} Shield CV)</span>` : "";
        const dCvTail = dShieldCV > 0 ? ` <span style="opacity:0.75;">(+${dShieldCV} Shield CV)</span>` : "";
        const fragment =
            `<div class="wdm-attack-rider">` +
                `<i class="fa-solid fa-people-arrows"></i> ` +
                `<strong>Bash → Physique vs Physique</strong>` +
                `<div class="wdm-bash-rolls" style="display:grid;grid-template-columns:1fr 1fr;gap:0.5rem;margin-top:0.375rem;">` +
                    `<div>` +
                        `<div><b>${esc(attacker.name)}</b> — Physique +${aTotalBase}${aCvTail}</div>` +
                        aDiceHtml +
                    `</div>` +
                    `<div>` +
                        `<div><b>${esc(target.name)}</b> — Physique +${dTotalBase}${dCvTail}</div>` +
                        dDiceHtml +
                    `</div>` +
                `</div>` +
                `<div style="margin-top:0.375rem;">Totals: <b>${aTotal}</b> vs <b>${dTotal}</b> — delta <b>${delta >= 0 ? "+" : ""}${delta}</b>.</div>` +
                verdictHead + pushLine + staggerLine +
            `</div>`;
        if (msg) {
            await appendAttackResult(msg, {
                fragment,
                summaryAdd: {
                    label: attackerWins ? "Bash: pushed" : "Bash: held",
                    kind:  attackerWins ? "hit" : "miss",
                    icon:  "fa-people-arrows"
                }
            });
        }
    } catch (err) {
        console.warn("witcher-ttrpg-death-march | bash outcome roll failed", err);
        ui.notifications?.warn?.("Bash outcome: roll failed.");
    }
}

/** Return owned actors that can Stand Aside for the given defender:
 *  own the actor + hold the "standAside" heroic + have ≥ 1 adrenaline +
 *  enough STA + are on the same scene + adjacent (Chebyshev ≤ 1 tile) to
 *  the defender's token. Also skips the defender themselves and any actor
 *  the current user doesn't own. */
function findStandAsideCandidates(defender, defToken, attackerUuid = "") {
    const results = [];
    const defCenter = { x: defToken?.center?.x ?? defToken?.x ?? 0, y: defToken?.center?.y ?? defToken?.y ?? 0 };
    const gridSize = Number(canvas?.scene?.grid?.size) || 0;
    if (!gridSize) return results;
    const staCost = (typeof adrenalineStaPerDie === "function") ? adrenalineStaPerDie() : 10;
    /* Actors the current user is targeting on canvas — used to filter out
     * "the Manticore is queued to attack this defender themselves" cases.
     * Read once so we don't hit the target set per-token. */
    const userTargetUuids = new Set(
        Array.from(game.user?.targets ?? [])
            .map(t => t?.actor?.uuid)
            .filter(Boolean)
    );
    for (const tok of (canvas?.tokens?.placeables ?? [])) {
        const a = tok?.actor;
        if (!a || !a.isOwner) continue;
        if (a === defender || a.uuid === defender?.uuid) continue;
        /* Skip if this Manticore IS the attacker of the current card —
         * you can't jump in front of your own strike. */
        if (attackerUuid && a.uuid === attackerUuid) continue;
        /* Skip if this Manticore is currently targeting the defender —
         * they're queued to attack the same actor, not protect them. */
        if (userTargetUuids.has(defender?.uuid)) continue;
        try {
            if (wrHeroic(a) !== "standAside") continue;
        } catch (_) { continue; }
        const ae = Number(a.system?.adrenaline?.value) || 0;
        const sta = Number(a.system?.derivedStats?.sta?.value) || 0;
        if (ae < 1 || sta < staCost) continue;
        const cx = tok.center?.x ?? tok.x ?? 0;
        const cy = tok.center?.y ?? tok.y ?? 0;
        const dx = Math.abs(defCenter.x - cx) / gridSize;
        const dy = Math.abs(defCenter.y - cy) / gridSize;
        if (Math.max(dx, dy) > 1) continue;
        results.push({ actor: a, token: tok });
    }
    return results;
}

/** Witchers Reborn — Manticore · Stand Aside handler. The Manticore leaps
 *  in front of the ally; the SAME attack (roll unchanged) is now directed
 *  at them, and they get a fresh defense prompt against it. On a successful
 *  defense (delta ≤ 0), no damage; on a failed defense (delta > 0), the
 *  Manticore takes the hit using THEIR armor/SP.
 *
 *  Costs 1 adrenaline + STA (debited up front; refunded if the Manticore
 *  bails out of the defense prompt). Reads attack metadata from message
 *  flags (attackerName/weaponName/attackKind/attackHitLocation/attackTotal),
 *  runs `requestDefenseFromOwner` locally against the Manticore, computes
 *  a new delta, and stamps result flags so damage-apply routes correctly:
 *   - `wr.standAsideDefended = true`  → damage skipped entirely
 *   - `wr.standAsideTarget   = mUuid` → damage lands on the Manticore */
async function applyStandAsideFromButton(btn) {
    if (btn?.dataset?.consumed === "1") return;
    const actorUuid = btn?.dataset?.actorUuid;
    const msgUuid   = btn?.dataset?.msgUuid;
    const defUuid   = btn?.dataset?.defenderUuid;
    if (!actorUuid || !msgUuid) return;
    const actor = await fromUuid(actorUuid);
    const msg   = game.messages?.get?.(msgUuid.split(".").pop()) ?? await fromUuid(msgUuid);
    if (!actor || !msg) return;
    const ae = Number(actor.system?.adrenaline?.value) || 0;
    const sta = Number(actor.system?.derivedStats?.sta?.value) || 0;
    const staCost = (typeof adrenalineStaPerDie === "function") ? adrenalineStaPerDie() : 10;
    if (ae < 1) {
        ui.notifications?.warn(`Stand Aside needs 1 adrenaline — ${actor.name} has ${ae}.`);
        return;
    }
    if (sta < staCost) {
        ui.notifications?.warn(`Stand Aside needs ${staCost} STA — ${actor.name} has ${sta}.`);
        return;
    }
    btn.dataset.consumed = "1";
    for (const sibling of (btn.closest(".wdm-wr-rider")?.querySelectorAll?.("button") ?? [])) {
        sibling.disabled = true;
    }
    try {
        await actor.update({ "system.adrenaline.value": ae - 1 });
        if (typeof actor.spendStamina === "function") {
            await actor.spendStamina(staCost, { reason: "wrStandAside" });
        } else {
            await actor.update({ "system.derivedStats.sta.value": sta - staCost });
        }
        /* Attack metadata stamped by weaponAttack's flags-fn (see
         * `attackerName`/`attackKind`/etc. on the message). Fall back
         * to msg.speaker.alias when a legacy card lacks the flag. */
        const attackerName      = msg.getFlag(SYSTEM_ID, "attackerName") ?? msg?.speaker?.alias ?? "Attacker";
        const attackWeaponName  = msg.getFlag(SYSTEM_ID, "attackWeaponName") ?? "Weapon";
        const attackWeaponImg   = msg.getFlag(SYSTEM_ID, "attackWeaponImg") ?? "";
        const attackKind        = msg.getFlag(SYSTEM_ID, "attackKind") ?? "normal";
        const attackHitLocation = msg.getFlag(SYSTEM_ID, "attackHitLocation") ?? null;
        const attackTotal       = Number(msg.getFlag(SYSTEM_ID, "attackTotal"));
        /* Open the defense prompt for the Manticore. Runs locally on
         * their client (since they clicked the button on their own
         * client). Returns { action, defenseTotal, defenseChips, ... }. */
        const packet = await requestDefenseFromOwner({
            defenderActor: actor,
            attackerName,
            weaponName:    attackWeaponName,
            weaponImg:     attackWeaponImg,
            engagementId:  msg.getFlag(SYSTEM_ID, "engagementId") ?? "",
            attackKind,
            shotIndex:     1,
            totalShots:    1,
            disallowedItemIds: [],
            attackerDamageFlags: null,
            attackHitLocation
        });
        /* Bail-out refund path: closed the dialog without picking a
         * defense at all (rare — the dialog defaults to "take it" on
         * timeout, so this only fires if the caller explicitly clears
         * the packet). */
        if (!packet || !packet.action) {
            await actor.update({ "system.adrenaline.value": ae });
            if (typeof actor.spendStamina === "function") {
                /* Refund a "negative spend" — reset STA to pre-spend value. */
                const nowSta = Number(actor.system?.derivedStats?.sta?.value) || 0;
                await actor.update({ "system.derivedStats.sta.value": nowSta + staCost });
            }
            return;
        }
        const defenseTotal = Number.isFinite(packet.defenseTotal) ? packet.defenseTotal : 10;
        const delta = Number.isFinite(attackTotal) ? attackTotal - defenseTotal : 0;
        const defended = delta <= 0;
        /* Stamp the result on the message so damage-apply routes correctly.
         *   - Defended → no target, no damage.
         *   - Not defended → target = Manticore, damage lands on them
         *     (their SP + resistances used in the calculator). */
        if (defended) {
            await msg.setFlag(SYSTEM_ID, "wr.standAsideDefended", true);
        } else {
            await msg.setFlag(SYSTEM_ID, "wr.standAsideTarget", actor.uuid);
        }
        const defender = defUuid ? await fromUuid(defUuid) : null;
        const verdictText = defended
            ? `${actor.name} ${packet.action === "parry" ? "parries" : packet.action === "block" ? "blocks" : packet.action === "dodge" ? "dodges" : "defends"} the attack (defense ${defenseTotal} vs attack ${attackTotal}${Number.isFinite(delta) ? `, tie or better goes to defender` : ""}) — no damage.`
            : `${actor.name} takes the hit (defense ${defenseTotal} vs attack ${attackTotal}, over by ${delta}) — damage lands on ${actor.name}.`;
        const leapLine = defender
            ? `${actor.name} leaps in front of ${defender.name}. `
            : `${actor.name} leaps in. `;
        btn.closest(".wdm-wr-rider")?.replaceWith(
            (() => {
                const div = document.createElement("div");
                div.className = "wdm-attack-rider wdm-wr-rider-result";
                div.innerHTML =
                    `<i class="fa-solid fa-shield-heart"></i> ` +
                    `<strong>Stand Aside</strong> — ${esc(leapLine)}${esc(verdictText)}`;
                return div;
            })()
        );
    } catch (err) {
        console.warn("witcher-ttrpg-death-march | Stand Aside apply failed", err);
    }
}

/** Witchers Reborn — Manticore · Riposte rider handler. Off-turn reaction
 *  attack: the parrier strikes back at the original attacker immediately,
 *  with whichever hand item they picked. The attacker actor is passed
 *  straight to `weaponAttack` via `forceDefender` — the riposte's target
 *  is always "whoever just swung at me", full stop. No canvas targeting
 *  gymnastics. `skipActionGate: true` bypasses the not-their-turn block
 *  since the riposte fires on the attacker's turn. */
async function applyRiposteStrikeFromButton(btn) {
    if (btn?.dataset?.consumed === "1") return;
    const actorUuid    = btn?.dataset?.actorUuid;
    const weaponUuid   = btn?.dataset?.weaponUuid;
    const attackerUuid = btn?.dataset?.attackerUuid;
    const staCost      = Number(btn?.dataset?.staCost) || 0;
    if (!actorUuid || !weaponUuid || !attackerUuid || staCost <= 0) return;
    const actor    = await fromUuid(actorUuid);
    const weapon   = await fromUuid(weaponUuid);
    const attacker = await fromUuid(attackerUuid);
    if (!actor || !weapon || !attacker) return;
    const sta = Number(actor.system?.derivedStats?.sta?.value) || 0;
    if (sta < staCost) {
        ui.notifications?.warn(`Riposte needs ${staCost} STA — ${actor.name} has ${sta}.`);
        return;
    }
    btn.dataset.consumed = "1";
    /* Disable every button in the rider so a second click can't fire
     * while the attack dialog is open. */
    for (const sibling of (btn.closest(".wdm-wr-rider")?.querySelectorAll?.("button") ?? [])) {
        sibling.disabled = true;
    }
    try {
        if (typeof actor.spendStamina === "function") {
            await actor.spendStamina(staCost, { reason: "wrRiposte" });
        } else {
            await actor.update({ "system.derivedStats.sta.value": sta - staCost });
        }
        btn.closest(".wdm-wr-rider")?.replaceWith(
            (() => {
                const div = document.createElement("div");
                div.className = "wdm-attack-rider wdm-wr-rider-result";
                div.innerHTML =
                    `<i class="fa-solid fa-shield-heart"></i> ` +
                    `<strong>Riposte</strong> — ${esc(actor.name)} spent ${staCost} STA and ` +
                    `strikes at ${esc(attacker.name)} with ${esc(weapon.name)}.`;
                return div;
            })()
        );
        const res = await actor.weaponAttack(weapon, {
            skipActionGate: true,
            forceDefender: attacker
        });
        if (!res) {
            const cur = Number(actor.system?.derivedStats?.sta?.value) || 0;
            await actor.update({ "system.derivedStats.sta.value": cur + staCost });
        }
    } catch (err) {
        console.warn("witcher-ttrpg-death-march | Riposte strike failed", err);
    }
}

/** Witchers Reborn — Deadly Focus upgrade handler. Debits N adrenaline
 *  from the attacker AND their per-die STA cost (RAW default 10 STA/die,
 *  configurable via the adrenalineStaPerDie system setting), then
 *  rewrites the attack message's `critSeverity` flag to the next tier.
 *  rollDamageFromButton reads that flag when the damage button fires,
 *  so the upgraded severity's +N crit bonus lands on the damage roll.
 *  Also strips the rider button + updates the verdict text on the card. */
async function upgradeDeadlyFocusFromButton(btn, msg) {
    if (btn?.dataset?.consumed === "1") return;
    const attackerUuid = btn?.dataset?.attackerUuid;
    const attackMsgUuid = btn?.dataset?.attackMsgUuid;
    const nextSeverity = btn?.dataset?.nextSeverity;
    const aeCost       = Number(btn?.dataset?.aeCost) || 0;
    if (!attackerUuid || !nextSeverity || aeCost <= 0) return;
    const attacker = await fromUuid(attackerUuid);
    if (!attacker) return;
    const ae = Number(attacker.system?.adrenaline?.value) || 0;
    if (ae < aeCost) {
        ui.notifications?.warn(`Deadly Focus needs ${aeCost} adrenaline — ${attacker.name} has ${ae}.`);
        return;
    }
    const staPerDie = adrenalineStaPerDie();
    const staCost   = aeCost * staPerDie;
    const staCur    = Number(attacker.system?.derivedStats?.sta?.value) || 0;
    if (staCur < staCost) {
        ui.notifications?.warn(`Deadly Focus needs ${staCost} STA (${aeCost} adrenaline × ${staPerDie}/die) — ${attacker.name} has ${staCur}.`);
        return;
    }
    btn.dataset.consumed = "1";
    btn.disabled = true;
    try {
        /* Debit adrenaline + STA. STA routes through spendStamina so
         * satiety / stun / other STA-driven hooks see the debit. */
        await attacker.update({ "system.adrenaline.value": ae - aeCost });
        if (staCost > 0) {
            if (typeof attacker.spendStamina === "function") {
                await attacker.spendStamina(staCost, { reason: "wrDeadlyFocus" });
            } else {
                await attacker.update({ "system.derivedStats.sta.value": staCur - staCost });
            }
        }
        const targetMsg = attackMsgUuid ? await fromUuid(attackMsgUuid) : msg;
        if (targetMsg) {
            /* Rewrite the flag AND swap the visible verdict text so the
             * card reflects the new severity. The damage button reads
             * the flag; the verdict text is player-facing. */
            const cur = String(targetMsg.content ?? "");
            const nextLabel = nextSeverity[0].toUpperCase() + nextSeverity.slice(1);
            const upgradedVerdict = cur
                .replace(/HIT — \w+ CRIT/i, `HIT — ${nextLabel.toUpperCase()} CRIT`)
                .replace(/is-crit-\w+/g, `is-crit-${nextSeverity}`);
            /* Strip the Deadly Focus rider from the content so it can't
             * fire twice. */
            const tmp = document.createElement("div");
            tmp.innerHTML = upgradedVerdict;
            tmp.querySelectorAll('[data-wr-rider="deadlyFocus"]').forEach(n => n.remove());
            await targetMsg.update({
                content: tmp.innerHTML,
                [`flags.${SYSTEM_ID}.critSeverity`]: nextSeverity
            });
        }
        const notice = `<div class="wdm-attack-rider wdm-wr-rider-result"><i class="fa-solid fa-crosshairs"></i> <strong>Deadly Focus</strong> — ${attacker.name} upgrades crit to <strong>${nextSeverity[0].toUpperCase() + nextSeverity.slice(1)}</strong> (spent ${aeCost} adrenaline + ${staCost} STA).</div>`;
        if (targetMsg) {
            await appendAttackResult(targetMsg, { fragment: notice });
        }
    } catch (err) {
        console.warn("witcher-ttrpg-death-march | Deadly Focus upgrade failed", err);
    }
}

/** Witchers Reborn — Pirouette handler. Prompts the attacker for a die
 *  count, debits AE + STA at the RAW per-die rate, and stacks the bonus
 *  on the attacker's own `wr.pirouetteBonus` flag. The next attack that
 *  consumes feintAdvantage adds this to the base +3 feint bonus (see
 *  the feintBonus computation in the attack roll assembly). Both flags
 *  clear together when the follow-up attack fires. */
async function rollPirouetteFromButton(btn, msg) {
    if (btn?.dataset?.consumed === "1") return;
    const attackerUuid = btn?.dataset?.attackerUuid;
    if (!attackerUuid) return;
    const attacker = await fromUuid(attackerUuid);
    if (!attacker) return;
    const ae  = Number(attacker.system?.adrenaline?.value)      || 0;
    const sta = Number(attacker.system?.derivedStats?.sta?.value) || 0;
    if (ae <= 0) {
        ui.notifications?.warn(`Pirouette: ${attacker.name} has no adrenaline.`);
        return;
    }
    const staPer  = adrenalineStaPerDie();
    const staPool = Math.floor(sta / staPer);
    const maxDice = Math.min(ae, staPool);
    if (maxDice <= 0) {
        ui.notifications?.warn(`Pirouette needs at least ${staPer} STA per die — ${attacker.name} has ${sta}.`);
        return;
    }
    const DialogV2 = foundry?.applications?.api?.DialogV2;
    if (!DialogV2) return;
    const dice = await DialogV2.prompt({
        window: { title: "Pirouette — adrenaline dice" },
        content:
            `<div style="padding:8px 0; font-size:0.8125rem;">` +
                `<label style="display:flex; gap:10px; align-items:center;">` +
                    `<span style="min-width:80px;">Dice</span>` +
                    `<input type="number" name="dice" min="1" max="${maxDice}" step="1" value="1" autofocus />` +
                `</label>` +
                `<p class="hint" style="opacity:0.7; margin-top:6px;">Up to ${maxDice} (limited by adrenaline pool + STA @ ${staPer}/die). Each die adds +1 to <strong>${attacker.name}</strong>'s next attack's feint bonus (base +3).</p>` +
            `</div>`,
        ok: { label: "Spin", callback: (_e, b) => Number(b.form?.elements?.dice?.value) || 0 },
        rejectClose: false
    }).catch(() => null);
    if (!dice || dice <= 0) return;
    const spend = Math.max(1, Math.min(maxDice, Math.round(dice)));
    btn.dataset.consumed = "1";
    btn.disabled = true;
    try {
        await attacker.update({ "system.adrenaline.value": ae - spend });
        const staCost = spend * staPer;
        if (staCost > 0) {
            if (typeof attacker.spendStamina === "function") {
                await attacker.spendStamina(staCost, { reason: "wrPirouette" });
            } else {
                await attacker.update({ "system.derivedStats.sta.value": sta - staCost });
            }
        }
        const prior = Number(attacker.getFlag?.(SYSTEM_ID, "wr.pirouetteBonus")) || 0;
        await attacker.setFlag(SYSTEM_ID, "wr.pirouetteBonus", prior + spend);
        const total = 3 + prior + spend;
        const fragment =
            `<div class="wdm-attack-rider wdm-wr-rider-result">` +
                `<i class="fa-solid fa-shoe-prints"></i> ` +
                `<strong>Pirouette</strong> — ${esc(attacker.name)}'s next attack at <strong>+${total}</strong> ` +
                `<span style="opacity:0.7;">(base +3 feint +${prior + spend} pirouette; spent ${spend} adrenaline + ${staCost} STA)</span>` +
            `</div>`;
        if (msg) {
            try {
                const tmp = document.createElement("div");
                tmp.innerHTML = String(msg.content ?? "");
                tmp.querySelectorAll('[data-wr-rider="pirouette"]').forEach(n => n.remove());
                await msg.update({ content: tmp.innerHTML });
            } catch (_) { /* renderer already replaced content */ }
            await appendAttackResult(msg, { fragment });
        }
        /* Rewrite the feint-summary chat message ("next attack at +3")
         * to reflect the new total so a reader scanning chat doesn't
         * see a stale +3 line right above a +N Pirouette rider. */
        try {
            const summaryMsgId = attacker.getFlag?.(SYSTEM_ID, "wr.feintSummaryMsgId");
            if (summaryMsgId) {
                const summaryMsg = game.messages?.get?.(summaryMsgId);
                if (summaryMsg) {
                    const targetName = summaryMsg.getFlag(SYSTEM_ID, "feintTargetName") ?? "target";
                    await summaryMsg.update({
                        content: `<em><strong>${esc(attacker.name)}</strong> feints — next attack against <strong>${esc(targetName)}</strong> at <strong>+${total}</strong>.</em>`
                    });
                }
            }
        } catch (_) { /* summary rewrite is a nicety, not load-bearing */ }
    } catch (err) {
        console.warn("witcher-ttrpg-death-march | Pirouette apply failed", err);
    }
}


/** Witchers Reborn — Forceful Blow action button.
 *
 * Appears next to Roll Damage on a HIT with a strong strike when the
 * attacker owns the perk. Clicking it:
 *   1. Debits 5 STA via spendStamina.
 *   2. Rolls the damage formula TWICE.
 *   3. Picks the higher total and applies it via emitApplyDamage — same
 *      pipeline as the normal Roll Damage button, so SP / crit bonus /
 *      oil bonus / silver all still fold in downstream.
 *   4. Appends a damage block showing BOTH dice trays with a note about
 *      which roll was kept.
 *   5. Strips both this button AND the regular Roll Damage button so
 *      neither can fire twice.
 *
 * The button carries the same data attributes as Roll Damage
 * (formula / types / locMult / locLabel / locKey / silver / weaponUuid /
 * qualities), plus the attacker uuid so the STA debit can find them.
 */
async function rollForcefulBlowDamageFromButton(btn, msg) {
    if (btn?.dataset?.consumed === "1") return;
    const formula      = btn?.dataset?.formula;
    const attackerUuid = btn?.dataset?.attackerUuid;
    if (!formula || !attackerUuid) return;
    let attacker = null;
    try { attacker = await fromUuid(attackerUuid); } catch (_) { /* stale */ }
    if (!attacker) {
        ui.notifications?.warn(game.i18n.localize("WITCHER.WR.ForcefulBlow.NoAttacker"));
        return;
    }
    const staValue = Number(attacker.system?.derivedStats?.sta?.value) || 0;
    if (staValue < 5) {
        ui.notifications?.warn(game.i18n.format("WITCHER.WR.ForcefulBlow.NoStamina",
            { name: attacker.name, sta: staValue }));
        return;
    }
    btn.dataset.consumed = "1";
    btn.disabled = true;
    try {
        /* Debit STA first so a mid-flow error still charges the cost. */
        if (typeof attacker.spendStamina === "function") {
            await attacker.spendStamina(5, { reason: "wrForcefulBlow" });
        } else {
            await attacker.update({ "system.derivedStats.sta.value": staValue - 5 });
        }
        /* Roll the damage formula twice and pick the higher total. Both
         * trays are rendered on the chat card so the player sees which
         * roll landed. */
        const rollA = await new Roll(formula).evaluate();
        const rollB = await new Roll(formula).evaluate();
        const totalA = Number(rollA.total) || 0;
        const totalB = Number(rollB.total) || 0;
        const keptRoll = totalA >= totalB ? rollA : rollB;
        const keptTotal = Math.max(totalA, totalB);
        const keptLabel = totalA >= totalB ? "Roll A" : "Roll B";
        const diceHtmlA = await rollA.render();
        const diceHtmlB = await rollB.render();

        /* Silver portion — rolled once, since Silver damage doesn't
         * benefit from Forceful Blow's reroll rule (RAW is silent; we
         * follow the "physical strike" interpretation). */
        const silverFormula = String(btn?.dataset?.silverFormula ?? "").trim();
        const silverRoll = silverFormula ? await new Roll(silverFormula).evaluate() : null;
        const silverTotal = silverRoll ? Number(silverRoll.total) || 0 : 0;
        const silverDiceHtml = silverRoll ? await silverRoll.render() : "";
        const types    = btn.dataset.types || "";
        const typeKeysRaw = (() => {
            try {
                const arr = JSON.parse(btn.dataset.typeKeys || "[]");
                return Array.isArray(arr) ? arr.map(String).filter(Boolean) : [];
            } catch (_) { return []; }
        })();
        const locMult  = Number(btn.dataset.locMult) || 1;
        const locLabel = btn.dataset.locLabel || "";
        const locKey   = btn.dataset.locKey || "";
        const weaponUuid = btn.dataset.weaponUuid || "";

        const head = game.i18n.localize("WITCHER.Attack.Damage");
        const note = locMult !== 1
            ? `<div class="wdm-attack-damage-note">${esc(game.i18n.localize("WITCHER.Attack.SubtractSP"))} ×${esc(locMult)}${locLabel ? ` (${esc(locLabel)})` : ""}</div>`
            : "";
        const silverBlockHtml = silverRoll
            ? `<div class="wdm-attack-damage-silver">` +
                  `<div class="wdm-attack-damage-roll-head">` +
                      `${esc(game.i18n.localize("WITCHER.Attack.SilverDamage") || "Silver Damage")} ` +
                      `<span class="wdm-attack-damage-roll-types" style="opacity:0.7;">— applies only vs. silver-resistant</span>` +
                  `</div>` +
                  silverDiceHtml +
              `</div>`
            : "";

        const damageBlockHtml =
            `<div class="wdm-attack-damage-roll-block" data-rider="forcefulBlow">` +
                `<div class="wdm-attack-damage-roll-head">` +
                    `<i class="fa-solid fa-hammer"></i> <strong>Forceful Blow</strong> — ${esc(head)}${types ? ` <span class="wdm-attack-damage-roll-types">— ${esc(types)}</span>` : ""} ` +
                    `<span style="opacity:0.7;">(rolled A ${totalA}, B ${totalB}; kept <strong>${keptLabel}</strong> @ ${keptTotal}; spent 5 STA)</span>` +
                `</div>` +
                note +
                `<div class="wdm-attack-damage-roll-a" style="opacity:${totalA >= totalB ? "1" : "0.55"};">` +
                    `<div class="wdm-attack-damage-roll-head"><em>Roll A${totalA >= totalB ? " — kept" : ""}</em></div>` +
                    diceHtmlA +
                `</div>` +
                `<div class="wdm-attack-damage-roll-b" style="opacity:${totalB >  totalA ? "1" : "0.55"};">` +
                    `<div class="wdm-attack-damage-roll-head"><em>Roll B${totalB >  totalA ? " — kept" : ""}</em></div>` +
                    diceHtmlB +
                `</div>` +
                silverBlockHtml +
            `</div>`;

        if (msg) {
            /* Strip BOTH the Forceful Blow rider AND the regular Roll
             * Damage button — the swing has been rolled, neither should
             * survive. The summary action slot's damage button is also
             * cleared via appendAttackResult's summaryAction:"". */
            try {
                const tmp = document.createElement("div");
                tmp.innerHTML = String(msg.content ?? "");
                tmp.querySelectorAll(".wdm-attack-damage").forEach(n => n.remove());
                tmp.querySelectorAll(".wdm-attack-damage-note").forEach(n => n.remove());
                tmp.querySelectorAll(".wdm-card-sum-roll").forEach(n => n.remove());
                tmp.querySelectorAll('[data-wr-rider="forcefulBlow"]').forEach(n => n.remove());
                tmp.querySelectorAll("details.wdm-attack-card").forEach(c => {
                    delete c.dataset.summaryActionHtml;
                });
                await msg.update({ content: tmp.innerHTML });
            } catch (_) { /* renderer already replaced content */ }
            await appendAttackResult(msg, { fragment: damageBlockHtml, summaryAction: "" });
        }

        /* Apply the kept damage to the attacker's targets — same target
         * resolution rollDamageFromButton uses. Prefer the stamped
         * `defenderUuid` flag first (authoritative — set by weaponAttack
         * when the defender was resolved, incl. Riposte's forceDefender),
         * then live canvas targets, then the tokenless combat-tracker
         * target. Crit severity + oil bonus + qualityRiders all fold
         * through the normal handleApplyDamage pipeline; Forceful Blow
         * only affects the pre-SP damage roll. */
        let targets = [];
        try {
            const stampedDefUuid = msg?.getFlag?.(SYSTEM_ID, "defenderUuid");
            if (stampedDefUuid) {
                const stamped = await fromUuid(stampedDefUuid);
                if (stamped) targets = [stamped];
            }
        } catch (_) { /* no stamped defender */ }
        if (!targets.length) {
            targets = Array.from(game.user?.targets ?? [])
                .map(t => t?.actor)
                .filter(a => !!a);
        }
        if (!targets.length) {
            try {
                const tokenlessTarget = await getActorTarget();
                if (tokenlessTarget) targets = [tokenlessTarget];
            } catch (_) { /* no actor-target flag set */ }
        }
        /* Witchers Reborn — Manticore · Stand Aside: same retarget as the
         * normal damage flow (see rollDamageFromButton above). Forceful
         * Blow's twin-roll kept damage still lands on the Manticore
         * instead of the original defender when the rider was clicked. */
        try {
            const standAsideUuid = msg?.getFlag?.(SYSTEM_ID, "wr.standAsideTarget");
            if (standAsideUuid) {
                const rerouted = await fromUuid(standAsideUuid);
                if (rerouted) targets = [rerouted];
            }
        } catch (_) { /* flag missing / stale */ }
        /* Stand Aside successful defense: skip damage entirely. */
        if (msg?.getFlag?.(SYSTEM_ID, "wr.standAsideDefended")) {
            targets = [];
        }
        if (targets.length && keptTotal > 0) {
            const { keys: qualityKeys, values: qualityValues } = readQualityPayload(btn);
            /* Read the same crit-detection flags rollDamageFromButton
             * reads so a Forceful Blow into a crit still triggers the
             * crit branch on the damage side. */
            const engagementId = msg?.getFlag?.(SYSTEM_ID, "engagementId") ?? "";
            const attackTotal  = Number(msg?.getFlag?.(SYSTEM_ID, "attackTotal"));
            const stampedSev   = msg?.getFlag?.(SYSTEM_ID, "critSeverity") ?? null;
            let defenseTotal   = Number(msg?.getFlag?.(SYSTEM_ID, "defenseTotal"));
            if (!Number.isFinite(defenseTotal)) defenseTotal = engagementId ? lookupDefenseTotal(engagementId) : null;
            const delta = (Number.isFinite(attackTotal) && Number.isFinite(defenseTotal))
                ? (attackTotal - defenseTotal) : null;
            const critSeverity = stampedSev ?? (delta != null ? critSeverityFromDelta(delta) : null);
            for (const actor of targets) {
                try {
                    await emitApplyDamage({
                        targetUuid:        actor.uuid,
                        weaponDamage:      keptTotal,
                        silverDamage:      silverTotal,
                        damageTypes:       typeKeysRaw.length
                            ? typeKeysRaw
                            : (types ? types.toLowerCase().split(/[\s·,/]+/).filter(Boolean) : []),
                        locationKey:       locKey,
                        locationLabel:     locLabel,
                        qualities:         qualityKeys,
                        qualityValues,
                        critSeverity,
                        weaponUuid,
                        attackMessageUuid: msg?.uuid ?? null
                    });
                } catch (err) {
                    console.warn(`witcher-ttrpg-death-march | Forceful Blow damage apply to ${actor.name} failed`, err);
                }
            }
        }
    } catch (err) {
        console.warn("witcher-ttrpg-death-march | Forceful Blow damage roll failed", err);
    }
}

/** Default declaration used when the dialog is skipped — a plain normal
 *  attack against a random location, no situational modifiers. `forcedExtra`
 *  mirrors the dialog: when no normal action is left the shot uses the extra
 *  action and carries its -3 (the STA cost is spent by the action economy).
 *
 *  `overrides` lets callers (notably tests and the combat dock's macro
 *  hooks) bypass the dialog while still selecting a strike type / specific
 *  hit location — without it the path was forever locked to a normal
 *  random-location strike, which meant skipDialog could never drive Fast /
 *  Joint / Charge / Strong / etc. (Multi-shot loops therefore never fired
 *  from the skipDialog path.) */
function defaultDeclaration(baseTotal, forcedExtra = false, aimBonus = 0, offhandPenalty = 0, overrides = {}) {
    let modTotal = 0;
    const chips = [];
    /* Apply the chosen strike's to-hit modifier before forcedExtra / offhand
     * stack on top (RAW: strike penalty is part of the attack roll, not the
     * stamina/extra-action surcharge). Reads the active strike table so a
     * Combat Extended toggle flip swaps in CE costs/labels without
     * requiring this mixin to know which ruleset is live. The CE table's
     * default key for a plain strike is "single"; legacy is "normal" —
     * fall back to whichever exists in the active table. */
    const strikeTable = getActiveStrikeTable(STRIKE_TYPES);
    const fallbackKey = strikeTable.normal ? "normal" : (strikeTable.single ? "single" : Object.keys(strikeTable)[0]);
    const strikeKey  = overrides.strike && strikeTable[overrides.strike] ? overrides.strike : fallbackKey;
    const strikeMeta = strikeTable[strikeKey];
    if (strikeMeta?.toHit) {
        modTotal += strikeMeta.toHit;
        chips.push({ label: game.i18n.localize(strikeMeta.labelKey ?? `WITCHER.Attack.Strike${strikeKey[0].toUpperCase() + strikeKey.slice(1)}`), value: strikeMeta.toHit });
    }
    if (forcedExtra) {
        modTotal += EXTRA_ACTION.toHit;
        chips.push({ label: game.i18n.localize("WITCHER.Attack.ExtraActionForced"), value: EXTRA_ACTION.toHit });
    }
    if (offhandPenalty) {
        modTotal += offhandPenalty;
        chips.push({ label: game.i18n.localize("WITCHER.Attack.OffHand"), value: offhandPenalty });
    }
    if (aimBonus) {
        modTotal += aimBonus;
        chips.push({ label: game.i18n.localize("WITCHER.Attack.Aim"), value: aimBonus });
    }
    const location = overrides.location ?? { mode: "random", kind: "human", penalty: 0, mult: null };
    return {
        strike: strikeKey, strikeMeta,
        extraAction: forcedExtra, aimBonus,
        location,
        range: { mod: 0 }, situational: [], otherMod: 0,
        weather: { total: 0, parts: [] }, chips, modTotal,
        grandMod: baseTotal + modTotal
    };
}

export const weaponAttackMixin = (Base) => class extends Base {

    /**
     * Roll an attack with a weapon. `weapon` is a WitcherItem of type
     * "weapon"; `options` may carry { dc, modifier, skipDialog }.
     *
     * Opens the attack modifier dialog (unless `options.skipDialog`), then
     * posts one chat card per shot. Returns the result of the last shot (or
     * null if the weapon is invalid or the dialog was cancelled).
     */
    async weaponAttack(weapon, options = {}) {
        // Shields bash as a Melee weapon (Core p.164) — they ride the same flow
        // as weapons, only their damage is derived from Punch (see damageFor).
        if (!weapon || (weapon.type !== "weapon" && weapon.type !== "shield")) return null;

        /* Charging status — set by the dock's Full Round → Charge
         * action. When active: attack dialog restricts its strike
         * picker to Strong only. Post-dialog we translate `strong` →
         * `charge` so the existing fullRound + blocked-prone rider
         * machinery fires. The status is stripped after the strike
         * commits. */
        const _wasCharging = !!this.statuses?.has?.("charging");

        /* Broken-weapon gate. A weapon with reliability.max > 0 and
         * reliability.value === 0 has been worn out and snapped (e.g.
         * absorbing too many blocks). It stays in its equipped slot for
         * UX continuity (user spec: "doesn't return to inventory") but
         * can no longer attack — the player has to swap or repair. */
        const relMax = Number(weapon.system?.reliability?.max) || 0;
        const relVal = Number(weapon.system?.reliability?.value) || 0;
        if (relMax > 0 && relVal <= 0) {
            ui.notifications?.warn(`${weapon.name} is broken — repair it before attacking.`);
            return null;
        }

        /* No-target safety: if the user has no targeted token, prompt
         * for confirmation. Catches accidental attack-button clicks
         * with nothing aimed at. Skip the prompt for scripted callers
         * (skipDialog) and when the user is the GM attacking an
         * inanimate (no defender). */
        if (!options.skipDialog && !options.forceDefender && !game.user?.targets?.size) {
            /* Accept a tokenless actor-target (set via the combat-tracker
             * context menu) as a valid target too — without this gate,
             * theater-of-mind attacks (or any attack where the GM picked
             * the defender through the tracker instead of the canvas)
             * triggered the "no target" prompt despite a target being set.
             * Mirrors the same fallback the defender resolution below uses. */
            let trackerTarget = null;
            try { trackerTarget = await getActorTarget(); } catch (_) { /* none */ }
            if (!trackerTarget) {
                const DialogV2 = foundry?.applications?.api?.DialogV2;
                if (DialogV2) {
                    let go = false;
                    try {
                        go = await DialogV2.confirm({
                            window: { title: `Attack without a target?` },
                            content:
                                `<p>You haven't targeted anyone. Roll an attack with <strong>${esc(weapon.name)}</strong> anyway?</p>` +
                                `<p style="opacity:0.7;font-size:0.6875rem;">Tip: click an enemy token to target it (T-key on a hovered token), or set a target from the combat tracker's context menu.</p>`,
                            rejectClose: false
                        });
                    } catch (_) { go = false; }
                    if (!go) return null;
                }
            }
        }

        /* Action-economy gate (Core p.151) — block out-of-turn attacks and
         * over-budget attacks BEFORE rolling. Out of combat there's no gate;
         * in combat: must be your turn, not action-locked, and have a slot
         * (normal or extra) left. nextActionSlot returns null when both
         * slots are spent. Skip the gate for skipDialog scripted callers
         * (tests, macros) — they opt out via options.skipActionGate. */
        if (this._inActiveCombat && !options.skipActionGate) {
            if (!this._isMyTurn) {
                ui.notifications?.warn(`${this.name} can't attack — not their turn.`);
                return null;
            }
            if (this._actionLocked || this._recoveryLocked) {
                ui.notifications?.warn(this._actionLockMsg ?? `${this.name} can't act right now.`);
                return null;
            }
            if (this.nextActionSlot === null) {
                ui.notifications?.warn(`${this.name} has no actions left this turn.`);
                return null;
            }
        }

        // Ranged weapons must be ready to fire. Chambered weapons (crossbows)
        // need a round in the chamber; bows need eligible ammo in an equipped
        // quiver. Refuse the attack outright if not — don't roll, don't spend.
        if (weapon.usesAmmo) {
            const ready = weapon.hasChamber ? weapon.isLoaded : !!weapon.getSelectedAmmo();
            if (!ready) {
                const key = weapon.hasChamber ? "WITCHER.Attack.NotLoaded" : "WITCHER.Attack.NoAmmo";
                ui.notifications?.warn(game.i18n.format(key, { name: weapon.name }));
                return null;
            }
        }

        // A weapon's roll profile: effective stats, the skill total behind it,
        // accuracy and the combined base to-hit. Factored so a Joint Attack's
        // off-hand weapon can be read with its own skill/accuracy.
        const readWeaponProfile = (w, skillKeyOverride = null) => {
            const weff = w.system?.effective ?? {};
            // Quality-driven skillOverride (Brawling weapon = "brawling"):
            // wins over the weapon's own skillKey when present. Explicit
            // caller-passed override (joint-attack off-hand) wins over the
            // quality so combat code retains its targeted reads.
            const qsKey = (() => {
                if (skillKeyOverride) return null;
                const cat = (typeof getActiveWeaponQualities === "function" ? getActiveWeaponQualities() : null)
                    ?? WEAPON_QUALITIES;
                const qs = weff.qualities ?? w.system?.qualities ?? [];
                for (const q of qs) {
                    const k = String(cat[q]?.skillOverride ?? "").trim();
                    if (k) return k;
                }
                return null;
            })();
            const wSkillKey = skillKeyOverride || qsKey || w.system?.skillKey || "";
            const wsv = wSkillKey ? this._readSkillValues(wSkillKey) : null;
            const wAccuracy = Number(weff.accuracy ?? w.system?.accuracy) || 0;
            return { eff: weff, skillKey: wSkillKey, sv: wsv,
                     accuracy: wAccuracy, baseTotal: (wsv?.total ?? 0) + wAccuracy };
        };
        // Read-only skill/WA chips for a profile (shown at the top of the card).
        const baseChipsFor = (p) => [
            p.sv ? { label: statName(p.sv.meta.statKey), value: p.sv.statVal } : null,
            p.sv ? { label: "Skill", value: p.sv.skillVal } : null,
            p.sv && p.sv.skillMod ? { label: "Mod", value: signed(p.sv.skillMod) } : null,
            p.accuracy ? { label: "WA", value: signed(p.accuracy) } : null
        ].filter(Boolean);

        const mainProf   = readWeaponProfile(weapon);
        const flatMod    = Number(options.modifier) || 0;
        const baseTotal  = mainProf.baseTotal;

        // Read-only skill/WA chips shown at the top of the dialog card.
        const baseChips = baseChipsFor(mainProf);

        // Dual-mode weapon: the card lets the player throw it or strike in
        // hand. Under the new schema, any melee weapon with a non-empty
        // range field is throwable — the range IS the throwability marker.
        // The throw itself always rolls Athletics (hard-coded in the strike
        // table); the weapon's own `skillKey` drives the melee mode. Falls
        // back to `meleeSkillKey` as legacy — pre-migration data stored the
        // melee skill there before the compendium was rewritten. Bows /
        // crossbows (weaponType="ranged") never qualify.
        const meleeSkillKey = weapon.system?.skillKey || weapon.system?.meleeSkillKey;
        const weaponRange   = String(weapon.system?.range ?? "").trim();
        const hasRealRange  = weaponRange.length > 0
                              && !/^n\/?a$/i.test(weaponRange)
                              && weaponRange !== "-" && weaponRange !== "--";
        const dualMode  = weapon.system?.weaponType === "melee" && hasRealRange && !!meleeSkillKey;
        const meleeProf = dualMode ? readWeaponProfile(weapon, meleeSkillKey) : null;
        const meleeBase = meleeProf ? { total: meleeProf.baseTotal, chips: baseChipsFor(meleeProf) } : null;

        // Aim (Core p.152): a ranged shot auto-consumes the actor's Aim status,
        // adding its rank bonus to the to-hit. The dialog reads the same rank
        // for its live preview; the skip-dialog path folds it in here. The
        // status is cleared after the shot(s) below.
        const isRanged = isRangedWeapon(weapon);
        const aimBonus = isRanged ? (Number(this.aimBonus) || 0) : 0;

        // Collect declared modifiers from the dialog (or fall back to a plain
        // normal attack when skipped).
        const cm = this.system?.combatMods ?? {};
        let decl;
        if (options.skipDialog) {
            const offRed = Number(cm.offhandPenaltyReduction) || 0;
            const offhandPenalty = isOffhandWeapon(weapon) ? Math.min(0, -3 + offRed) : 0;
            decl = defaultDeclaration(baseTotal, this.nextActionSlot === "extra", aimBonus, offhandPenalty,
                { strike: options.strike, location: options.location });
        } else {
            decl = await openAttackDialog(weapon, this, {
                base: { total: baseTotal, chips: baseChips },
                meleeBase,
                /* Monster mode strips strike-variant tabs (Strong/Fast/Joint/
                 * Feint are PC-only per RAW p.153) and range/weather/ammo
                 * controls (monster ranged attacks don't model range the
                 * same way), keeping the dialog focused on the modifier
                 * fields and target row the GM actually wants. */
                monsterMode: !!options.monsterMode
            });
            if (!decl) return null;   // player cancelled
        }
        /* Charging translation + status clear. When the actor was
         * charging, the dialog restricted the picker to Strong only —
         * user picked strong (default), we now internally rewrite it
         * to Charge so the existing fullRound + blocked-prone rider
         * machinery fires. Both the "what did the user pick" check
         * and the "which key IS charge in this ruleset" lookup go
         * through the active strike table + category mapping (RAW
         * key `strong` = CE key `strongAttack`; RAW `charge` = CE
         * `charge`). Downstream `decl.strike === "charge"` checks
         * still work because both tables use the "charge" category. */
        if (_wasCharging) {
            const cfg = await import("../../setup/config.mjs").catch(() => null);
            const ceMod = await import("../../data/combatExtended/actions.mjs").catch(() => null);
            const strikeTable = ceMod?.getActiveStrikeTable
                ? ceMod.getActiveStrikeTable(cfg?.STRIKE_TYPES ?? {})
                : (cfg?.STRIKE_TYPES ?? {});
            /* Category map — matches attackDialog's cat() so RAW and CE
             * keys resolve the same category. */
            const STRIKE_CATEGORY = {
                normal: "normal",  single: "normal",
                strong: "strong",  strongAttack: "strong",
                fast:   "fast",    fastAttack:  "fast",
                joint:  "joint",   jointAttack:  "joint",
                charge: "charge",
                pommel: "pommel",  pommelStrike: "pommel"
            };
            const decoCat = STRIKE_CATEGORY[decl.strike] ?? decl.strike;
            const isPromoteable = decoCat === "strong" || decoCat === "normal";
            if (isPromoteable) {
                /* Find the CHARGE key in the active table (RAW "charge",
                 * CE "charge" — same key by convention, but resolve via
                 * category lookup in case a GM renamed it). */
                let chargeKey = "charge";
                for (const [k, _v] of Object.entries(strikeTable)) {
                    if ((STRIKE_CATEGORY[k] ?? k) === "charge") { chargeKey = k; break; }
                }
                decl.strike = chargeKey;
                if (strikeTable[chargeKey]) decl.strikeMeta = strikeTable[chargeKey];
            }
            try { await this.toggleStatusEffect?.("charging", { active: false }); }
            catch (_) { /* best-effort */ }
        }

        /* Defense pre-roll prompt: if there's a targeted token whose actor
         * isn't us and isn't an inanimate-DC target, ask its owner what
         * defense they want to use. The owner sees a modal with their
         * available defenses (Parry / Block / Dodge / Take it). When they
         * pick one, defendWith / rollDodge fires on their client and posts
         * their defense card to chat. We block the attack roll until they
         * answer (or the 30s timeout fires → treats as "Take it"), so the
         * defender always gets to react first. */
        const _targets = Array.from(game.user?.targets ?? []);
        const _firstTarget = _targets[0];
        /* Token target wins when present; otherwise fall back to the per-user
         * actor-target flag set by the combat-tracker context menu (lets
         * tokenless play — theater of mind — still drive defender prompts
         * and engagement-linked verdict patching).
         *
         * `options.forceDefender` overrides everything — used by callers like
         * Manticore Riposte where the defender is programmatically known
         * from a rider click; the canvas target may not have propagated to
         * `game.user.targets` in the same event tick, so we bypass that
         * resolution entirely and use the actor passed in directly. */
        let _defenderActor = options.forceDefender ?? _firstTarget?.actor;
        if (!_defenderActor) {
            try { _defenderActor = await getActorTarget(); }
            catch (_) { _defenderActor = null; }
        }
        /* Dialog-driven per-shot target assignment.  When decl.targetUuids
         * is populated, each shot pairs to a specific defender (Fast may
         * hit two different actors; Normal/Strong/Trip/Feint/Joint stay
         * single-target — Joint's second shot reuses index 0 further
         * down).  Resolves once here; each iteration of the shot loop
         * mutates `_defenderActor` to the correct entry.  A null entry
         * means "unassigned" → the loop `continue`s that shot. */
        let _perShotDefenders = null;
        if (!options.forceDefender && Array.isArray(decl?.targetUuids) && decl.targetUuids.length) {
            _perShotDefenders = [];
            for (const uuid of decl.targetUuids) {
                try {
                    const a = uuid ? await fromUuid(uuid) : null;
                    _perShotDefenders.push(a ?? null);
                } catch (_) { _perShotDefenders.push(null); }
            }
            /* Seed the pre-loop defender with the first assigned actor
             * so range / hold / reach / feint-flag calculations that
             * fire OUTSIDE the shot loop still hit a live target. */
            const firstAssigned = _perShotDefenders.find(Boolean);
            if (firstAssigned) _defenderActor = firstAssigned;
        }
        const _willPrompt = _defenderActor
            && _defenderActor !== this
            && !options.dc && !decl.targetDC
            /* Feint (both variants) is an opposed skill check, not a
             * physical defense choice — the defender rolls a
             * fixed skill (RAW: their Awareness; CE: the SAME weapon
             * skill the attacker used) and the delta decides the
             * outcome. Skip the parry/block/dodge/reposition prompt
             * for either. */
            && decl.strike !== "feint";
        /* Items the defender already committed to a previous shot in THIS
         * declaration — passed to subsequent prompts so a joint-attack's
         * second prompt can disallow the parry item used in the first
         * (RAW Core p.163: "must have two weapons (or a weapon and a
         * shield) if they want to block or parry both attacks"). Fast
         * strikes don't enforce this — the same item parries both at the
         * cost of 1 STA per extra defense. */
        const _usedDefenseItemIds = [];

        // Which mode the attack resolved in.
        //   - A dual-mode melee weapon (has a range) picked in melee mode
        //     rolls the melee profile, isn't a ranged shot, and stays in hand.
        //   - A throw (dialog "thrown" mode OR the throw strike itself) rolls
        //     ATHLETICS regardless of the weapon's own skillKey. Athletics is
        //     a DEX skill — throwing is a DEX action, not a per-weapon
        //     specialty. The strike carries decl.strikeMeta.thrown = true.
        //   - Everything else: normal mainProf for the weapon.
        const useMelee   = dualMode && decl.mode === "melee";
        const isThrowStrike = !!(decl.strikeMeta?.thrown);
        const throwProf  = isThrowStrike ? readWeaponProfile(weapon, "athletics") : null;
        const activeProf = throwProf ?? (useMelee ? meleeProf : mainProf);
        // A throw is a ranged shot (arc + range brackets apply) even though
        // the weapon is weaponType="melee". Three routes into ranged:
        //   1. The strike itself is a throw (isThrowStrike).
        //   2. The weapon's weaponType is "ranged" (bow / crossbow) AND
        //      it isn't being taken in melee mode.
        //   3. The DIALOG picked "thrown" mode for a dual-mode weapon.
        //      `dualMode` here uses the same check as the dialog (melee
        //      weaponType + real range), so this triggers cleanly.
        const isThrownMode = decl.mode === "thrown";
        const firedRanged = isThrowStrike || isThrownMode || (isRanged && !useMelee);

        /* ── Melee reach gate ────────────────────────────────────────
         * A melee swing needs the target inside the weapon's reach.
         * Base reach = 1 tile (adjacent). The three EO reach qualities
         * extend it:
         *   Long Reach       → +2m  (~2 tiles total on a 1.5m grid)
         *   Superior Reach   → +4m  (~3 tiles total)
         *   Extreme Reach    → +6m  (~4 tiles total)
         *
         * We skip the check for thrown / ranged shots (those have their
         * own range brackets) and for feints (Deceit check, not a
         * physical swing). We also skip when either side lacks a
         * canvas token — theatre-of-mind play trusts the GM. Refusing
         * the attack surfaces a ui.notifications warning so the
         * player knows why the click didn't take. */
        if (!firedRanged && !isThrowStrike && decl.strike !== "feint" && _defenderActor) {
            const attackerToken = this?.getActiveTokens?.()?.[0];
            const targetToken   = _defenderActor?.getActiveTokens?.()?.[0];
            const gridSize      = Number(canvas?.scene?.grid?.size)     || 0;
            const gridMeters    = Number(canvas?.scene?.grid?.distance) || 1.5;
            if (attackerToken && targetToken && gridSize > 0) {
                const ac = { x: attackerToken.center?.x ?? attackerToken.x, y: attackerToken.center?.y ?? attackerToken.y };
                const tc = { x: targetToken.center?.x   ?? targetToken.x,   y: targetToken.center?.y   ?? targetToken.y   };
                const tiles = Math.max(Math.abs(ac.x - tc.x), Math.abs(ac.y - tc.y)) / gridSize;
                /* Reach in meters — 0 for a plain melee weapon,
                 * additive for long/superior/extreme reach. Convert to
                 * tiles for the Chebyshev comparison. */
                const wq = weapon?.system?.effective?.qualities ?? weapon?.system?.qualities ?? [];
                const qCat = (typeof getActiveWeaponQualities === "function" ? getActiveWeaponQualities() : null) ?? WEAPON_QUALITIES;
                let reachExtendMeters = 0;
                for (const k of wq) {
                    const v = Number(qCat?.[k]?.reachExtendMeters) || 0;
                    if (v > reachExtendMeters) reachExtendMeters = v;
                }
                const reachTiles = 1 + Math.floor(reachExtendMeters / gridMeters);
                if (tiles > reachTiles) {
                    const reachLabel = reachExtendMeters > 0
                        ? `${reachTiles} tiles / ${gridMeters + reachExtendMeters}m`
                        : `1 tile / ${gridMeters}m`;
                    ui.notifications?.warn(
                        `${weapon.name} — target is ${Math.round(tiles)} tiles away, out of reach (${reachLabel}).`
                    );
                    return null;
                }
            }
        }

        /* ── Throw range gate ─────────────────────────────────────────
         * When throwing, refuse the attack if the target sits beyond
         * the weapon's Extreme bracket (2× the listed range per Core
         * p.165). Same shape as the melee reach gate — a friendly
         * ui.notifications warning + early return so the shot doesn't
         * roll into automatic uselessness. Skipped when either token
         * is off-canvas (theater-of-mind), or when the range can't be
         * parsed (would need to be manually adjudicated). */
        if (isThrowStrike && _defenderActor) {
            const attackerToken = this?.getActiveTokens?.()?.[0];
            const targetToken   = _defenderActor?.getActiveTokens?.()?.[0];
            if (attackerToken && targetToken) {
                let distanceMeters = null;
                /* Try Foundry's grid.measureDistance first (v13-ish +
                 * some subgrid setups). v14+ returned null for common
                 * inputs in headless tests, so we ALWAYS fall through
                 * to the pixel-math backstop when the returned value
                 * isn't finite — same math the melee reach gate uses. */
                try {
                    const g = canvas?.grid;
                    if (typeof g?.measureDistance === "function") {
                        const d = g.measureDistance(attackerToken.center ?? attackerToken, targetToken.center ?? targetToken);
                        if (Number.isFinite(Number(d))) distanceMeters = Number(d);
                    }
                } catch (_) { /* fall through */ }
                if (!Number.isFinite(distanceMeters)) {
                    try {
                        const a = attackerToken.center ?? attackerToken;
                        const b = targetToken.center ?? targetToken;
                        const px = Math.hypot((a?.x ?? 0) - (b?.x ?? 0), (a?.y ?? 0) - (b?.y ?? 0));
                        const sz = Number(canvas?.scene?.grid?.size) || 100;
                        const gd = Number(canvas?.scene?.grid?.distance) || 1.5;
                        distanceMeters = (px / sz) * gd;
                    } catch (_) { /* fall through */ }
                }
                /* Reuse the dialog's parser so BODY×N + STAT×N expressions
                 * behave identically here. Ammo range modifiers folded in
                 * by resolveWeaponRange itself. */
                try {
                    const { resolveWeaponRange } = await import("../../applications/attackDialog.mjs");
                    const baseRange = await resolveWeaponRange?.(weapon, this, null);
                    /* Extreme bracket is `frac: 2` — 2× listed range. */
                    const maxThrowMeters = Number(baseRange) > 0 ? Number(baseRange) * 2 : null;
                    if (Number.isFinite(distanceMeters) && Number.isFinite(maxThrowMeters)
                        && distanceMeters > maxThrowMeters) {
                        ui.notifications?.warn(
                            `${weapon.name} — target is ${Math.round(distanceMeters)}m away, ` +
                            `out of throw range (max ${Math.round(maxThrowMeters)}m at Extreme).`
                        );
                        return null;
                    }
                } catch (_) { /* parser miss — trust the GM */ }
            }
        }

        // Extra action: the -3 to-hit is already folded into decl.modTotal. The
        // STA cost is NOT spent here — the caller (combat dock) routes an
        // extra-action declaration through the round's action economy
        // (recordExtraAction), which spends 3 STA only while in combat.

        // An inanimate/unaware target is hit against a flat range DC (set by
        // the dialog) rather than a contested defense. Fall back to the caller's
        // dc when the dialog wasn't used.
        const dc = decl.targetDC ?? options.dc ?? null;

        // Resolve the hit location. Called shots already carry their penalty in
        // decl.modTotal; a random location is rolled now (penalty 0) and only
        // contributes its damage multiplier. Inanimate shots have no location.
        let loc = decl.location;
        if (loc.mode === "random") {
            const { loc: key, face } = await rollHitLocation(loc.kind);
            const def = ATTACK_LOCATIONS[key];
            loc = {
                mode: "random", kind: loc.kind, key, face,
                penalty: 0, mult: def?.mult ?? 1,
                label: game.i18n.localize(def?.labelKey ?? key)
            };
        }

        // The strike multiplier (strong strike) scales the rolled dice. The
        // location multiplier is NOT folded into the roll: per RAW, armor SP is
        // subtracted from the damage FIRST and only the remainder is multiplied
        // by the location factor. So we roll strike-scaled damage and report
        // the location multiplier as an after-SP step on the card.
        const strikeMult = decl.strikeMeta?.dmgMult ?? 1;
        const locMult    = loc.mult ?? 1;

        // Special attacks: `noDamage` (disarm/trip) hide the damage line;
        // `note` (i18n key) surfaces the rider effect on the card. A Joint Attack
        // (`offhand`) rolls its second attack with a chosen off-hand weapon.
        const sMeta     = decl.strikeMeta ?? {};
        const noDamage  = !!sMeta.noDamage;
        const strikeNote = sMeta.note ? game.i18n.localize(sMeta.note) : "";
        const offhandWeapon = sMeta.offhand ? (this.items.get(decl.offhandId) ?? null) : null;

        // Feint (Core p.163): a SINGLE Deceit roll instead of an attack — no
        // weapon strike, no damage. If the target fails Awareness vs the Deceit,
        // the attacker's NEXT attack (a separate action) is at +3 (described in
        // the note; not auto-applied). The Deceit roll uses its own skill total,
        // no weapon accuracy and no called-shot penalty (it isn't aimed).
        const feintSkill   = sMeta.firstRollSkill || null;
        const feintProfile = feintSkill ? (() => {
            const sv = this._readSkillValues(feintSkill);
            return { eff: {}, skillKey: feintSkill, sv, accuracy: 0, baseTotal: sv?.total ?? 0 };
        })() : null;
        // The called-shot penalty folded into decl.modTotal — subtracted from the
        // feint's Deceit roll so a head-shot feint doesn't carry -6 on the feint.
        const locPenalty = (decl.location?.mode === "specific") ? (Number(decl.location.penalty) || 0) : 0;

        // Adrenaline dice committed in the dialog (Core p.176): each adds +1d6 to
        // the damage roll and costs `adrenalineStaPerDie()` STA (RAW 10), spent
        // when the attack is rolled. Re-clamp to the live pool in case it changed
        // since the dialog opened. Forced to 0 when the optional rule is off.
        const adrEnabled = isAdrenalineEnabled();
        const adrPool = adrEnabled ? Math.max(0, Number(this.system?.adrenaline?.value) || 0) : 0;
        const adrenalineDice = Math.min(adrPool, Math.max(0, Math.round(Number(decl.adrenalineDice) || 0)));

        // Build a weapon's damage display + rollable formula, honouring the
        // strike multiplier and the noDamage suppression. `adr` extra d6 are
        // appended OUTSIDE the strike multiplier (flat bonus dice, not doubled).
        const damageFor = (w, adr = 0, ammoItem = null) => {
            const d = w.type === "shield"
                ? shieldBashDamage(this, w)
                : (w.system?.effective?.damage || w.system?.damage || "");
            if (noDamage || !d) return { display: "", formula: "", silverFormula: "" };
            /* Derived melee bonus (Core p.48): ceil((BODY-6)/2)×2, added to
             * weapon damage on melee and thrown swings when the weapon's
             * `appliesMeleeBonus` flag is on (default true). Ranged shots
             * (bow/crossbow) don't add it; shield-bash formulas already bake
             * the actor's punch — which itself contains the bonus — so we
             * skip on shields to avoid double-counting. Folded INSIDE the
             * strike multiplier so Strong Strike doubles it, matching the
             * silver-portion treatment and the base-system convention. */
            const isRangedShot = firedRanged && !isThrowStrike;
            const applyMB = w.type === "weapon"
                && !isRangedShot
                && (w.system?.appliesMeleeBonus !== false);
            const mb = applyMB ? (Number(this.system?.derivedStats?.meleeBonus) || 0) : 0;
            const base = mb !== 0
                ? `${d} ${mb > 0 ? "+" : "-"} ${Math.abs(mb)}`
                : d;
            let display = strikeMult !== 1 ? `${base} ×${strikeMult}` : base;
            let formula = strikeMult !== 1 ? `(${base})*${strikeMult}` : base;
            if (adr > 0) { display += ` + ${adr}d6`; formula += ` + ${adr}d6`; }
            /* Half Damage ammo (Whistling Bullet, Markee Howler, Flaming
             * Arrow/Bolt, Incendiary, etc.) — halve the weapon's base damage
             * BEFORE silver/adrenaline are factored. RAW: typically rounded
             * down; we use floor() in the formula. */
            const ammoQs = ammoItem ? (ammoItem.system?.qualities ?? []) : [];
            if (ammoQs.includes("halfDamage")) {
                display = `floor((${display})/2)`;
                formula = `floor((${formula})/2)`;
            }
            /* Silver damage formula (Silver quality, hybrid steel-with-silver-
             * inlay weapons). Only the formula portion — the calculator decides
             * per-target whether to fold it in (target has resistNonSilver →
             * halve(base) + silver; otherwise silver is ignored). Mirrors the
             * strike multiplier so a Strong silver hit doubles both halves. */
            const qs   = w.system?.effective?.qualities    ?? w.system?.qualities    ?? [];
            const qVal = w.system?.effective?.qualityValues ?? w.system?.qualityValues ?? {};
            const silverRaw = qs.includes("silver") ? String(qVal.silver ?? "").trim() : "";
            const silverFormula = silverRaw
                ? (strikeMult !== 1 ? `(${silverRaw})*${strikeMult}` : silverRaw)
                : "";
            return { display, formula, silverFormula };
        };
        /* EO open-category quality bonuses. Per-weapon authored text on
         * Close Quarters / Two-Hand / Throwing / Strangling. We parse out
         * "+N WA" → to-hit and "+NdM" → extra damage dice (appended OUTSIDE
         * the strike multiplier so a Strong Strike doesn't double the bonus,
         * matching Adrenaline dice handling). The raw text is echoed in the
         * card note for any unparsed clause (range bonus, status, etc.). */
        const _targetActor   = _defenderActor ?? null;
        /* Close Quarters fires ONLY when this attacker is the partner in
         * the target's hold (clinch/grapple/pin/chokehold). A bystander
         * who happens to be in attack range can't piggyback on someone
         * else's hold. The hold-link registry stores the partner UUID for
         * each held actor; we read it and compare. */
        let _isCloseQ = false;
        if (_targetActor?.statuses && (
            _targetActor.statuses.has?.("grappled")
            || _targetActor.statuses.has?.("pinned")
            || _targetActor.statuses.has?.("clinched")
            || _targetActor.statuses.has?.("chokeheld")
        )) {
            try {
                /* Multi-clinch: the target can be in several pairs
                 * (multiple attackers clinching one defender). Fire
                 * Close Quarters when THIS actor is on the other side
                 * of any of those pairs.
                 *
                 * Bug that used to prevent CQ from lighting up: pair
                 * partner uuids are stored as WORLD-actor uuids after
                 * the normalization fix, but `this.uuid` on a token-
                 * controlled actor is the SYNTHETIC uuid
                 * ("Scene.X.Token.Y.Actor.Z"). String-comparing raw
                 * uuids silently missed. Normalize before comparing. */
                const { getHoldLinks, normalizedActorUuid } = await import("../../mechanics/holdLink.mjs");
                const pairs = await getHoldLinks(_targetActor);
                const attackerUuid = normalizedActorUuid(this);
                _isCloseQ = !!(attackerUuid && pairs.some(p => p?.partnerUuid === attackerUuid));
            } catch (_) { /* fall through — no bonus if registry unreachable */ }
        }
        const openCatBonuses = getActiveOpenCategoryBonuses(weapon, {
            isCloseQuartersContext: !!_isCloseQ,
            isTwoHandedWield:       !!(weapon?.system?.twoHandMode || weapon?.system?.hands === "two"),
            isThrown:               !!(decl.strikeMeta?.thrown),
            isChokehold:            decl.strike === "chokehold"
        });
        const openCatWa  = sumOpenCategoryWa(openCatBonuses);
        const openCatTail = damageTailFromOpenCategory(openCatBonuses);
        /* Granted qualities from a parsed bonus text (e.g. Estoc's
         * "Close Quarters (Improved Armor Piercing)" → +AP only when
         * the close-quarters context fires). The chat-card flavor row
         * surfaces them in the qualities chip line so the defender
         * sees the rider. Downstream damage handlers (status riders
         * like Bleeding %, Armor Piercing dice halving) read from
         * `qualityKeys` on the chat message — we union the granted
         * keys into that list. */
        const openCatGrantedQualities = grantedQualitiesFromOpenCategory(openCatBonuses);
        const openCatGrantedQualityValues = grantedQualityValuesFromOpenCategory(openCatBonuses);

        const mainDamage = damageFor(weapon, adrenalineDice);
        if (openCatTail) {
            mainDamage.display = mainDamage.display ? `${mainDamage.display} ${openCatTail}` : openCatTail;
            mainDamage.formula = mainDamage.formula ? `${mainDamage.formula} ${openCatTail}` : openCatTail.replace(/^\+\s*/, "");
        }
        const damageStr  = mainDamage.display;

        // Status penalties to the attack (Staggered −2, Blinded −3, Prone −2,
        // Exhausted −1, …) folded straight onto the to-hit. Summed live from the
        // actor's active conditions by the status engine.
        const statusAtk = statusAttackMod(this);
        /* CE Combat Extended (2026-07-03) — grappler/pinner physical
         * penalty, WITH carve-out for the held partner. Zero when CE
         * is off; zero when attacking the actor's held partner (that's
         * the "except vs partner" rule). Also zero when the actor
         * isn't a holder of any grappling/pinning pair. */
        const ceHoldAtk = contextualPhysicalMod(this, _defenderActor);
        /* Actively Dodge (full round action) imposes -2 on ANY attack
         * against the actively-dodging target. Consumed here on the
         * attacker's side; the target's STA-recurrence exemption is
         * enforced in combatRoundMixin.recordDefense. */
        const activelyDodgeAtk = _defenderActor?.system?.combatRound?.activelyDodging ? -2 : 0;

        /* Combat Extended guard contribution to attacks now lives in
         * the attack dialog — it's rolled into decl.modTotal + decl.chips
         * up front so the pre-hit modifier breakdown shows it too. Kept
         * this comment as a signpost so future edits don't re-add the
         * fold here (double-counts silently — Fool's would look like +4). */

        if (openCatWa && Array.isArray(decl.chips)) {
            decl.chips.push({ label: openCatBonuses.map(b => b.label).join(" + "), value: openCatWa });
        }

        /* ── Phase 3 — Reach extension + adjacent-attack penalty (EO p.7-8)
         * Long / Superior / Extreme Reach extend a melee weapon's reach but
         * fumble at point-blank: attacks vs an ADJACENT defender (≤ 1.5m,
         * one grid square) get the listed −1/−3/−5 penalty.
         *   Superior Reach — pommel strike only at adjacent
         *   Extreme Reach  — no attack at all at adjacent (refuse + abort)
         * The reach extension itself is descriptive (the grid measurement
         * is the GM's purview); we surface it as a chip + chat-card note. */
        const reachInfo = weaponReachInfo(weapon);
        const reachDistance = (reachInfo.reachExtendMeters > 0 || reachInfo.reachAdjacentPenalty < 0)
            ? adjacencyDistanceMeters(this, _defenderActor, _firstTarget)
            : null;
        const reachIsAdjacent = (reachDistance != null) && (reachDistance <= 1.5);
        let reachAdjacentChip  = 0;
        let reachAdjacentNote  = "";
        if (reachInfo.reachExtendMeters > 0 && Array.isArray(decl.chips)) {
            decl.chips.push({
                label: game.i18n.localize("WITCHER.Attack.Reach") || "Reach",
                value: `+${reachInfo.reachExtendMeters}m`
            });
        }
        if (reachIsAdjacent && reachInfo.reachAdjacentPenalty < 0) {
            // Refuse outright on Extreme Reach
            if (reachInfo.reachAdjacentNoAttack && !options.skipDialog) {
                ui.notifications?.warn(`${weapon.name} (Extreme Reach) — can't attack an adjacent opponent.`);
                return null;
            }
            reachAdjacentChip = reachInfo.reachAdjacentPenalty;
            if (Array.isArray(decl.chips)) {
                decl.chips.push({ label: "Adjacent (Reach)", value: signed(reachAdjacentChip) });
            }
            if (reachInfo.reachAdjacentPommelOnly) {
                reachAdjacentNote = "Adjacent target — pommel strike only (Superior Reach).";
            } else if (reachInfo.reachAdjacentNoAttack) {
                reachAdjacentNote = "Adjacent target — Extreme Reach normally refuses; GM allowed it.";
            }
        }

        /* ── Phase 4 — Physique gating (EO p.7)
         * If the wielder's Physique skill base is lower than the listed
         * requirement, the attack rolls suffer a penalty equal to the
         * difference (always negative). Read system.skills.body.physique.value
         * (per data/actor/templates/skills.mjs SKILL_MAP physique → body). */
        const physiqueChip = (() => {
            const cat = getActiveWeaponQualities() ?? WEAPON_QUALITIES;
            const keys = weapon?.system?.effective?.qualities ?? weapon?.system?.qualities ?? [];
            let required = 0;
            for (const k of keys) {
                const entry = cat[k] ?? WEAPON_QUALITIES[k];
                if (!entry?.requiresMinPhysique) continue;
                /* Per-item authored value via qualityValues (the EO parameter
                 * placeholder is the number); fall back to the default in
                 * the catalog entry (8). */
                const wVals = weapon?.system?.effective?.qualityValues ?? weapon?.system?.qualityValues ?? {};
                const itemVal = Number(wVals[k]);
                const need = Number.isFinite(itemVal) && itemVal > 0
                    ? itemVal
                    : Number(entry.requiresMinPhysique) || 0;
                if (need > required) required = need;
            }
            if (required <= 0) return 0;
            const physBase = Number(this.system?.skills?.body?.physique?.value) || 0;
            if (physBase >= required) return 0;
            return physBase - required;       // always negative
        })();
        if (physiqueChip !== 0 && Array.isArray(decl.chips)) {
            decl.chips.push({ label: "Physique (under)", value: signed(physiqueChip) });
        }

        /* ── Phase 4 — Nimble extra-action STA reductions (EO p.7)
         * `drawStaReduction:2`         — applies when the extra action is
         *                                 the DRAW (we don't have a
         *                                 dedicated draw-action surface,
         *                                 so we apply it only when the
         *                                 actor is currently Fast-Drawing
         *                                 the weapon — `fastDraw` status).
         * `nimbleAttackStaReduction:2` — applies when the attack itself
         *                                 is via Extra Action.
         * Apply it to the actor's persisted extra-action STA via a small
         * REFUND after the round-mixin spends the canonical 3 STA. We
         * compute the refund here and stash it on `_nimbleStaRefund` to
         * be applied after the loop. */
        const nimbleAttackRed = (() => {
            const cat = getActiveWeaponQualities() ?? WEAPON_QUALITIES;
            const keys = weapon?.system?.effective?.qualities ?? weapon?.system?.qualities ?? [];
            let n = 0;
            for (const k of keys) {
                const entry = cat[k] ?? WEAPON_QUALITIES[k];
                n = Math.max(n, Number(entry?.nimbleAttackStaReduction) || 0);
            }
            return n;
        })();
        const nimbleDrawRed = (() => {
            const cat = getActiveWeaponQualities() ?? WEAPON_QUALITIES;
            const keys = weapon?.system?.effective?.qualities ?? weapon?.system?.qualities ?? [];
            let n = 0;
            for (const k of keys) {
                const entry = cat[k] ?? WEAPON_QUALITIES[k];
                n = Math.max(n, Number(entry?.drawStaReduction) || 0);
            }
            return n;
        })();
        const isFastDrawAttack = !!decl.fastDraw || !!this.statuses?.has?.("fastDraw");
        let nimbleStaRefund = 0;
        if (this.nextActionSlot === "extra" && nimbleAttackRed > 0) nimbleStaRefund += nimbleAttackRed;
        if (isFastDrawAttack && nimbleDrawRed > 0) nimbleStaRefund += nimbleDrawRed;

        /* ── Phase 8 — Ranged Penalty armor chip (EO p.8)
         * Heavy/restrictive armor on the ARMS imposes a flat penalty to
         * ranged attack rolls. Read every equipped armor piece carrying
         * `rangedPenalty` and sum its authored value (parameter); surface
         * as a chip. Author convention: parameter value is the MAGNITUDE
         * (e.g. "2" → −2 to ranged); we negate. Ranged only. */
        let rangedPenaltyChip = 0;
        if (isRanged) {
            const armorPieces = (this.items ?? []).filter?.(i =>
                i.type === "armor" && i.system?.equipped) ?? [];
            for (const a of armorPieces) {
                const qs = a.system?.effective?.qualities ?? a.system?.qualities ?? [];
                if (!qs.includes("rangedPenalty")) continue;
                const wVals = a.system?.effective?.qualityValues ?? a.system?.qualityValues ?? {};
                const v = Number(wVals.rangedPenalty);
                if (Number.isFinite(v) && v !== 0) {
                    rangedPenaltyChip += (v > 0 ? -v : v);
                }
            }
            if (rangedPenaltyChip !== 0 && Array.isArray(decl.chips)) {
                decl.chips.push({ label: "Armor Ranged Penalty", value: signed(rangedPenaltyChip) });
            }
        }

        /* ── Phase 7 — Grounded (EO p.8)
         * A grounded ranged weapon can't fire while mounted. We treat the
         * `mounted` status on the actor (or a `mount`-id flag) as the
         * mounted signal; absent a first-class mounted system we surface
         * an unconditional refuse if either status is present. */
        const isGrounded = (() => {
            const cat = getActiveWeaponQualities() ?? WEAPON_QUALITIES;
            const keys = weapon?.system?.effective?.qualities ?? weapon?.system?.qualities ?? [];
            for (const k of keys) {
                const entry = cat[k] ?? WEAPON_QUALITIES[k];
                if (entry?.groundedOnly === true) return true;
            }
            return false;
        })();
        const actorMounted = !!(
            this.statuses?.has?.("mounted")
            || this.system?.flags?.mounted
            || this.getFlag?.(SYSTEM_ID, "mounted")
        );
        if (isGrounded && actorMounted && !options.skipDialog) {
            ui.notifications?.warn(`${weapon.name} (Grounded) — can't fire while mounted or in a vehicle.`);
            return null;
        }

        /* ── Phase 6 — Charge family (EO p.7)
         * A "charge" strike prompts the player for meters moved (default 4m
         * — the average half-Run). Bonus damage dice:
         *   cavalry (mounted)         — Math.floor(m)   × 1d6
         *   footCharging (on foot)    — Math.floor(m/2) × 1d6
         *   charging (legacy Core)    — Math.floor(m)   × 1d6 mounted
         * The chip surfaces on the card; the dice are appended to the
         * damage formula OUTSIDE the strike multiplier (so a Strong Charge
         * doesn't double the charge bonus, matching adrenaline handling). */
        let chargeBonusDice = 0;
        let chargeBonusSrc  = "";
        if (decl.strike === "charge" && !options.skipDialog) {
            const cat = getActiveWeaponQualities() ?? WEAPON_QUALITIES;
            const keys = weapon?.system?.effective?.qualities ?? weapon?.system?.qualities ?? [];
            let best = { perMeter: 0, mode: "", key: "" };
            for (const k of keys) {
                const entry = cat[k] ?? WEAPON_QUALITIES[k];
                const per = Number(entry?.chargeBonusPerMeter) || 0;
                if (per > best.perMeter) best = { perMeter: per, mode: String(entry?.chargingMode || ""), key: k };
                else if (per === best.perMeter && entry?.chargingMode === "mounted") best = { perMeter: per, mode: "mounted", key: k };
            }
            if (best.perMeter > 0) {
                const wantsMounted = best.mode === "mounted";
                const wantsOnFoot  = best.mode === "onfoot";
                const meterPrompt = `<form><div class="form-group"><label>Meters moved</label><input type="number" name="meters" min="0" step="1" value="4"/></div></form>`;
                let meters = 4;
                try {
                    const DialogV2 = foundry?.applications?.api?.DialogV2;
                    if (DialogV2) {
                        const v = await DialogV2.prompt({
                            window: { title: `${weapon.name} — Charge (meters moved)` },
                            content: meterPrompt,
                            modal: true,
                            ok: { callback: (_e, btn) => Number(btn.form.elements.meters.value) || 0 },
                            rejectClose: false
                        }).catch(() => null);
                        if (v != null) meters = Math.max(0, Math.floor(Number(v) || 0));
                    }
                } catch (_) { /* keep default */ }
                /* Mode gating — Cavalry needs mounted; EO Charging is
                 * on-foot. Surface as a note when the actor's mounted state
                 * doesn't match the quality (no auto-refuse — GM judges). */
                const modeOk = (wantsMounted && actorMounted)
                            || (wantsOnFoot && !actorMounted)
                            || (best.mode === "" );
                if (modeOk) {
                    chargeBonusDice = (best.perMeter >= 1)
                        ? Math.floor(meters)
                        : Math.floor(meters / 2);
                    chargeBonusSrc = best.key;
                } else {
                    reachAdjacentNote = (reachAdjacentNote
                        ? reachAdjacentNote + " "
                        : "")
                        + `${weapon.name}: charge mode mismatch (needs ${wantsMounted ? "mounted" : "on-foot"}) — bonus not applied.`;
                }
            }
        }
        const chargeTail = chargeBonusDice > 0 ? `+${chargeBonusDice}d6` : "";
        if (chargeBonusDice > 0 && mainDamage.display) {
            mainDamage.display = `${mainDamage.display} ${chargeTail}`;
            mainDamage.formula = `${mainDamage.formula} ${chargeTail}`;
            if (Array.isArray(decl.chips)) {
                decl.chips.push({ label: `Charge (${chargeBonusSrc})`, value: `+${chargeBonusDice}d6` });
            }
        }

        /* Precision Strike (Cat, Witchers Reborn) doesn't need a code
         * branch — the perk's AE writes +2 to combatMods.calledShotReduction,
         * which attackDialog already reads at declaration time (see
         * applications/attackDialog.mjs) and folds into decl.location.penalty
         * before the dialog resolves. The reduced penalty rides through
         * decl.modTotal into the grandMod below with no extra plumbing. */
        const grandMod = activeProf.baseTotal + decl.modTotal + flatMod + statusAtk + ceHoldAtk + activelyDodgeAtk + openCatWa
            + reachAdjacentChip + physiqueChip + rangedPenaltyChip
            + (Number(cm.flatAttackMod) || 0);
        const formula  = grandMod ? `1d10 + ${grandMod}` : `1d10`;

        const localizeTypes = (keys) => (keys ?? [])
            .filter(t => typeof t === "string" && t.length > 0)
            .map(t => game.i18n.localize(CONFIG.WITCHER.damageTypes?.[t] ?? t))
            .filter(Boolean);

        // Location chip (shows the rolled face for random shots; omitted for
        // inanimate shots, which have no hit location).
        const locLabel = loc.mode === "random" ? `${loc.label} (d10: ${loc.face})` : loc.label;

        /* Hefty (house variant of EO p.7): Fast Strike is unavailable with
         * a Hefty weapon — the attackDialog filters the option out of the
         * strike picker (heftyBlocksFastStrike). If someone bypasses the
         * dialog and forces strike="fast"/"fastAttack" on a Hefty weapon,
         * we silently downgrade to a 1-attack Single Strike rather than
         * roll two of them. Defensive — should never fire via the UI. */
        const isFastStrike = decl.strike === "fast" || decl.strike === "fastAttack";
        const weaponQs = weapon?.system?.effective?.qualities ?? weapon?.system?.qualities ?? [];
        const hasHefty = weaponQs.some(q => WQ_CATALOG[q]?.heftyBlocksFastStrike === true);
        const heftyClamp = (isFastStrike && hasHefty) ? 1 : null;
        const attacks = heftyClamp ?? Math.max(1, decl.strikeMeta?.attacks ?? 1);
        const speaker = ChatMessage.getSpeaker({ actor: this });
        // Per-shot ammo (bows only): the dialog may declare one chosen round per
        // shot. Resolve each id to its item up-front so the card and the spend
        // agree. Falls back to the weapon's default round when unspecified.
        const isBow = !!weapon.usesAmmo && !weapon.hasChamber;
        const declAmmo = Array.isArray(decl.ammo) ? decl.ammo : null;
        const resolveAmmoById = (id) =>
            (weapon.getEligibleAmmo?.() ?? []).find(e => e.item.id === id || e.item.uuid === id)?.item ?? null;
        // Persist the primary chosen round so the dock / next attack reflect it.
        if (isBow && declAmmo?.[0]) {
            try { await weapon.selectAmmo(declAmmo[0]); }
            catch (err) { console.warn("witcher-ttrpg-death-march | selectAmmo failed", err); }
        }
        /* Bow multi-shot ammo gate: a Fast strike looses two arrows, a Joint
         * off-hand shot with a second bow adds another. Refuse the whole
         * attack up-front when the quiver holds fewer rounds than the strike
         * will spend. Tallies by ammo id: if the player picked the same
         * round for both shots the wielder needs 2 of THAT round; picking
         * different rounds only needs 1 of each. Free Ammunition weapons
         * skip the check (they don't deplete their stack). */
        if (isBow && attacks > 1) {
            const wq = weapon.system?.effective?.qualities ?? weapon.system?.qualities ?? [];
            if (!wq.includes("freeAmmunition")) {
                const eligible = weapon.getEligibleAmmo?.() ?? [];
                const stockById = new Map(eligible.map(e => [e.item.id, e.qty]));
                const stockByUuid = new Map(eligible.map(e => [e.item.uuid, e.qty]));
                const usedByAmmo = new Map();
                const defaultShot = defaultShotAmmo(weapon);
                for (let i = 0; i < attacks; i++) {
                    const shotId = declAmmo?.[i] ?? declAmmo?.[0] ?? null;
                    const ammo = shotId ? resolveAmmoById(shotId) : defaultShot;
                    if (!ammo) {
                        ui?.notifications?.warn?.(game.i18n.format("WITCHER.Attack.NoAmmo", { name: weapon.name }));
                        return null;
                    }
                    usedByAmmo.set(ammo.id, (usedByAmmo.get(ammo.id) ?? 0) + 1);
                }
                for (const [ammoId, need] of usedByAmmo) {
                    const have = stockById.get(ammoId) ?? stockByUuid.get(ammoId) ?? 0;
                    if (have < need) {
                        const ammoItem = eligible.find(e => e.item.id === ammoId)?.item;
                        const ammoName = ammoItem?.name ?? "ammo";
                        ui?.notifications?.warn?.(
                            `${weapon.name}: not enough ${ammoName} — need ${need}, have ${have}. Fast Strike loses two arrows in one action.`
                        );
                        return null;
                    }
                }
            }
        }
        let result = null;

        // Adrenaline dice ride the first (and, for a feint, only) shot.
        const damagingShot = 0;

        for (let i = 0; i < attacks; i++) {
            /* Per-shot defender resolution (dialog picker).  Joint keeps
             * both shots on the first-assigned target (RAW: two attacks
             * against the SAME opponent).  Fast reads its own index —
             * shot 0 → [0], shot 1 → [1] with fallback to [0] if the
             * player left shot 2 unassigned.  Missing entry with no
             * fallback skips the shot entirely (no defense request,
             * no roll, no damage — targets without an assigned attack
             * are not struck per user spec). */
            if (_perShotDefenders) {
                const jointStrike = decl.strikeMeta?.offhand === true;
                const perShot = jointStrike
                    ? (_perShotDefenders[0] ?? null)
                    : (_perShotDefenders[i] ?? _perShotDefenders[0] ?? null);
                if (!perShot) continue;
                _defenderActor = perShot;
            }

            // Feint: the one and only shot is a Deceit roll — no weapon strike, no
            // damage, no location. Everything else rolls the weapon.
            /* Two related flags:
             *   useAltSkill  — the strike carries a `firstRollSkill` and
             *                  the roll should use THAT profile (feint →
             *                  Deceit, bash → Brawling, future entries…).
             *   isFeintRoll  — the strike is specifically FEINT. Feint
             *                  bypasses the defense prompt, retitles the
             *                  card, strips called-shot penalty from the
             *                  first roll, etc. Bash uses the alt profile
             *                  but ISN'T feint, so those side effects
             *                  must not fire — hence the extra strike-key
             *                  gate. */
            const useAltSkill = !!feintProfile && i === 0;
            /* Feint side effects (defense prompt bypass, called-shot
             * penalty strip, card retitle, Awareness roll for the
             * defender, +3 next-attack flag, Pirouette rider) fire for
             * BOTH RAW Deceit-feint and CE weapon-skill-feint — the
             * only mechanical difference between the two is the skill
             * used for the attacker's roll. RAW carries
             * `firstRollSkill: "deceit"` (routes the roll through the
             * feint profile via useAltSkill); CE carries no
             * firstRollSkill, so the normal weapon profile is used. */
            const isFeintRoll = decl.strike === "feint" && i === 0;
            // Joint Attack: the second roll uses the chosen off-hand weapon with
            // its OWN skill/accuracy/damage; every other strike reuses the main
            // weapon for each shot.
            const shotWeapon = (offhandWeapon && i === 1) ? offhandWeapon : weapon;
            const isOff = shotWeapon !== weapon;

            /* Per-shot defense prompt — RAW: each strike in a Fast or Joint
             * attack is its own attack the defender must react to. We use a
             * fresh engagementId per shot so the damage button on each shot
             * pairs to the matching defense card for crit detection. */
            const _shotEngagementId = `eng-${Date.now()}-${i}-${Math.random().toString(36).slice(2)}`;
            decl._engagementId = _shotEngagementId;
            decl._defenseChoice = { action: "none" };
            /* Stunned (or otherwise defense-locked) target shortcut —
             * RAW Core p.161: "anyone attacking you only has to beat
             * DC:10 to hit you." Skip the defense prompt and seed
             * defenseTotal = 10 so the verdict patch treats the swing
             * as rolled against DC 10. Covers THREE sources of "can't
             * defend":
             *   1. AE-applied "stunned" status (actor.statuses)
             *   2. 0-STA stun (actor._stunned getter — RAW Core p.161
             *      kicks in when Stamina hits zero, may or may not be
             *      mirrored to the statuses Set)
             *   3. Any status clause with restrict.defend=true (cannotDefend)
             *      — catches Paralyzed, Unconscious, etc.
             * Previously only #1 was checked, so a 0-STA stunned actor
             * (or a Paralyzed one) still got the defense prompt. */
            const cantDefend = !!(
                _defenderActor?.statuses?.has?.("stunned")
                || _defenderActor?._stunned
                || cannotDefend(_defenderActor)
            );
            if (_willPrompt && !isFeintRoll && cantDefend) {
                decl._defenseChoice = { action: "stunned", defenseTotal: 10 };
            } else if (_willPrompt && !isFeintRoll) {
                try {
                    // Joint attack rule (Core p.163): the same parry/block
                    // item can't defend both shots — pass the items already
                    // used in earlier shots so the prompt disables them.
                    // Fast strikes don't enforce this (same weapon attacks
                    // twice; defender may parry both at 1 STA per extra).
                    const isJoint = !!offhandWeapon;
                    const disallowedItemIds = isJoint ? [..._usedDefenseItemIds] : [];
                    // Quality-driven defense gating: pass the attacker's
                    // weapon's damage flags so the prompt can strip Parry
                    // when the strike carries Crushing Force (or any GM-
                    // authored quality with `deniesParry`).
                    const shotQualities = shotWeapon.system?.effective?.qualities
                        ?? shotWeapon.system?.qualities ?? [];
                    const attackerDamageFlags = qualitiesToDamageFlags(shotQualities);
                    decl._defenseChoice = await requestDefenseFromOwner({
                        defenderActor:     _defenderActor,
                        attackerName:      this.name,
                        weaponName:        shotWeapon.name,
                        weaponImg:         shotWeapon.img,
                        engagementId:      _shotEngagementId,
                        attackKind:        decl.strike,
                        shotIndex:         i + 1,
                        totalShots:        attacks,
                        disallowedItemIds,
                        attackerDamageFlags,
                        /* CE Warding auto-apply: the defender needs the
                         * attack's hit location to know whether the
                         * strike is landing at the warded location
                         * (+2 parry/block) or elsewhere (−1). `loc.key`
                         * is populated for both called shots AND random
                         * rolls (the random d10 was already resolved
                         * above at line ~1450). Null for "inanimate /
                         * unaware" shots where there's no anatomy. */
                        attackHitLocation: loc.key ?? null,
                        /* Ranged / thrown attacks can only be blocked by a
                         * shield with cover value ≥ 1 — swords don't stop
                         * arrows and bolts. `firedRanged` already reflects
                         * both "shot from a bow/crossbow" and "hurled
                         * throw"; the defense prompt filters block items
                         * to cover-bearing shields when this is set. */
                        requiresShieldCover: !!firedRanged
                    });
                    if (decl._defenseChoice?.itemId) _usedDefenseItemIds.push(decl._defenseChoice.itemId);
                } catch (err) {
                    console.warn("witcher-ttrpg-death-march | defense prompt failed", err);
                    decl._defenseChoice = { action: "none" };
                }
            }

            const prof  = useAltSkill ? feintProfile
                        : isOff       ? readWeaponProfile(shotWeapon)
                        :               activeProf;

            // The round this shot fires: chosen bow ammo, chambered round, or none.
            // Ammo applies only to the (ranged) main weapon — an off-hand melee
            // shot never has any. A feint's Deceit roll fires nothing.
            const usesAmmo  = !isOff && !isFeintRoll && shotWeapon.usesAmmo;
            const shotAmmoId = (isBow && !isOff) ? (declAmmo?.[i] ?? declAmmo?.[0] ?? null) : null;
            const shotAmmo = (isBow && !isOff)
                ? (shotAmmoId ? resolveAmmoById(shotAmmoId) : defaultShotAmmo(weapon))
                : null;

            const wTypeKeys = shotWeapon.system?.effective?.damageTypes ?? shotWeapon.system?.damageTypes ?? [];
            const baseTypeKeys = usesAmmo
                ? [...new Set([...wTypeKeys, ...(shotAmmo?.system?.damageTypes ?? [])])]
                : wTypeKeys;
            /* Player picked a subset of the weapon's damage types in the
             * attack dialog (e.g. "spear can slash OR pierce, dealing
             * piercing this swing"). Intersect the weapon's full list
             * with the picker's selection so target resistances /
             * weaknesses land against the right type(s). No override →
             * fall back to the weapon's full list (RAW default). */
            const dtOverride = Array.isArray(decl.damageTypes) && decl.damageTypes.length
                ? decl.damageTypes : null;
            const typeKeys = dtOverride
                ? baseTypeKeys.filter(t => dtOverride.includes(t))
                : baseTypeKeys;
            const types = isFeintRoll ? [] : localizeTypes(typeKeys);
            const shotSkillName = prof.skillKey
                ? game.i18n.localize(CONFIG.WITCHER.skillLabel(prof.skillKey))
                : game.i18n.localize("WITCHER.attack.noSkill");
            /* Throw shots — CE or classic thrown weapon — surface the
             * weapon's range on the card so the defender knows the arc
             * they're facing. Only fires on the throw strike itself; a
             * normal melee stab doesn't show range. `N/A` and `--`
             * sentinels (bagh nakh, bullwhip, syringe) get filtered
             * out — even though canThrow now blocks those, an author
             * override could still hit the throw strike without a
             * meaningful range, and "Range N/A" reads poorly. */
            const rawRange = String(weapon?.system?.range ?? "").trim();
            const throwRangeStr = (isThrowStrike && rawRange
                && !/^n\/?a$/i.test(rawRange) && rawRange !== "-" && rawRange !== "--")
                    ? rawRange : "";
            const subtitle = [shotSkillName, types.join(" · ")].filter(Boolean).join(" · ");
            const qualities = isFeintRoll ? [] : (usesAmmo ? shotQualityLabels(shotWeapon, shotAmmo) : shotQualityLabels(shotWeapon, null));
            /* Raw quality KEYS / values for the post-hit rider logic. A feint
             * doesn't strike, so no riders fire. */
            const riderPayload = isFeintRoll
                ? { keys: [], values: {} }
                : (usesAmmo ? shotQualityRiders(shotWeapon, shotAmmo) : shotQualityRiders(shotWeapon, null));
            /* Open-category granted qualities (e.g. Close Quarters
             * (Improved Armor Piercing) on Estoc) — union them into the
             * rider payload so the post-hit handler actually fires the
             * granted quality. The bonus only applies when the context
             * predicate fired during attack setup, so this is a strict
             * per-strike addition rather than a permanent weapon quality. */
            if (!isFeintRoll && openCatGrantedQualities.length) {
                for (const q of openCatGrantedQualities) {
                    if (!riderPayload.keys.includes(q)) riderPayload.keys.push(q);
                }
                /* Granted-quality values authored in the open-category
                 * bonus (e.g. Close Quarters: Bleeding(25%) → 25% chance
                 * to bleed). Only writes keys that don't already have a
                 * value coming from the base weapon/ammo — so an Estoc
                 * with Bleeding 10% inherent keeps the 10% even if Close
                 * Quarters also grants Bleeding without an explicit
                 * value. The granted value only fills the gap. */
                for (const [q, v] of Object.entries(openCatGrantedQualityValues)) {
                    if (riderPayload.values[q] == null || riderPayload.values[q] === "") {
                        riderPayload.values[q] = v;
                    }
                }
                /* Also surface the granted labels in the qualities chip
                 * line so a defender reading the card sees that, e.g.,
                 * "Improved Armor Piercing" applied this strike. */
                const cat = getActiveWeaponQualities() ?? WEAPON_QUALITIES;
                for (const q of openCatGrantedQualities) {
                    const lbl = cat[q]?.label ?? q;
                    if (!qualities.includes(lbl)) qualities.push(lbl);
                }
            }

            /* Witchers Reborn — Viper · Sting: fires when the target is
             * stunned OR pinned, OR the attack itself is an ambush (the
             * situational Ambush checkbox in the attack dialog). Upgrade
             * chain on qualification:
             *     none → armorPiercing
             *     armorPiercing → improvedArmorPiercing
             *     improvedArmorPiercing → +5 flat damage
             * The +5 branch is a special-case flag pulled out on the
             * damage assemble path (see damageFor's stingBonus fold
             * below). Only fires on real strikes (not feint / Deceit). */
            if (!isFeintRoll && hasWRPerk(this, "sting")) {
                const targetStunned = !!(
                    _defenderActor?.statuses?.has?.("stunned")
                    || _defenderActor?._stunned
                );
                const targetPinned = !!(_defenderActor?.statuses?.has?.("pinned"));
                const isAmbush = Array.isArray(decl.situational)
                    && decl.situational.some(s => s?.value === "ambush");
                const stingFires = targetStunned || targetPinned || isAmbush;
                if (stingFires) {
                    const hasAP  = riderPayload.keys.includes("armorPiercing");
                    const hasIAP = riderPayload.keys.includes("improvedArmorPiercing");
                    if (hasIAP) {
                        /* Already at Improved AP — grant +5 damage via a
                         * marker flag the damage assembly reads. */
                        riderPayload.stingDamageBonus = 5;
                        qualities.push("Sting +5");
                    } else if (hasAP) {
                        riderPayload.keys = riderPayload.keys.filter(k => k !== "armorPiercing");
                        riderPayload.keys.push("improvedArmorPiercing");
                        qualities.push("Sting → Improved AP");
                    } else {
                        riderPayload.keys.push("armorPiercing");
                        qualities.push("Sting → AP");
                    }
                }
            }

            // Adrenaline dice land on the damaging shot only (one declaration per
            // attack), so a Fast strike's 2nd shot / a joint off-hand / a feint's
            // Deceit roll don't double-count them.
            const shotDamage   = isFeintRoll ? { display: "", formula: "" } : damageFor(shotWeapon, i === damagingShot ? adrenalineDice : 0, shotAmmo);
            /* Fold the OPEN-CATEGORY damage tail (Two-Hand / Throwing /
             * Close Quarters / Strangling contribute a "+ NdM" or "+ N"
             * fragment) AND the CHARGE damage tail (+Kd6 per meter moved)
             * into THIS shot's formula, not just the pre-loop mainDamage.
             * The chat card's `data-formula` reads from shotDamage.formula
             * — if we only mutate mainDamage the tail never reaches the
             * button. Feint rolls skip both (no damage on a Deceit
             * check). Charge tail already skips the fold when its dice
             * count is zero. */
            if (!isFeintRoll) {
                if (openCatTail && shotDamage.formula) {
                    shotDamage.display = shotDamage.display ? `${shotDamage.display} ${openCatTail}` : openCatTail;
                    shotDamage.formula = `${shotDamage.formula} ${openCatTail}`;
                }
                if (chargeBonusDice > 0 && shotDamage.formula) {
                    const _chargeTail = `+${chargeBonusDice}d6`;
                    shotDamage.display = `${shotDamage.display} ${_chargeTail}`;
                    shotDamage.formula = `${shotDamage.formula} ${_chargeTail}`;
                }
                /* Witchers Reborn — Viper · Sting: +5 flat damage when the
                 * target already had Improved AP (the "third tier" of the
                 * Sting upgrade chain). The riderPayload carries the
                 * marker; fold it into both display + rolled formula. */
                if (riderPayload.stingDamageBonus && shotDamage.formula) {
                    const stingTail = `+${riderPayload.stingDamageBonus}`;
                    shotDamage.display = `${shotDamage.display} ${stingTail}`;
                    shotDamage.formula = `${shotDamage.formula} ${stingTail}`;
                }
            }
            /* Feint advantage: a successful prior Feint stamps the
             * attacker with `flags.{sys}.feintAdvantage` = target uuid.
             * The +3 (and any Pirouette bonus) applies to the NEXT attack
             * ONLY when the current target EXACTLY matches the feinted
             * mark. No target, different target, or missing/mismatched
             * uuid all mean the flag burns below without the bonus
             * landing — the user has to re-target the feinted actor
             * before their follow-up to get the payoff. */
            const feintAdvTargetUuid = (!isFeintRoll && i === 0)
                ? (this.getFlag(SYSTEM_ID, "feintAdvantage") || null)
                : null;
            const feintAdv = !!feintAdvTargetUuid;
            const feintAdvMatchesTarget = feintAdv
                && typeof feintAdvTargetUuid === "string"
                && _defenderActor?.uuid === feintAdvTargetUuid;
            const pirouetteBonus = feintAdvMatchesTarget
                ? (Number(this.getFlag(SYSTEM_ID, "wr.pirouetteBonus")) || 0)
                : 0;
            const feintBonus = feintAdvMatchesTarget ? (3 + pirouetteBonus) : 0;

            // Feint's Deceit roll drops the called-shot penalty (it isn't aimed).
            // Precision Strike applies to each shot in a fast-strike volley, but
            // Precision Strike's called-shot penalty reduction is already
            // in decl.modTotal via the dialog's calledShotReduction fold —
            // no per-shot correction needed here.
            /* Feint / Pirouette follow-up bonuses are folded INTO
             * decl.modTotal by the dialog's `add()` calls (see
             * attackDialog.mjs "Witchers Reborn — feint follow-up
             * preview"). Don't re-add them here — that was the source
             * of the double-count. `feintAdvMatchesTarget` is still
             * consumed below to burn the flags on the post-write. */
            const shotGrandMod = prof.baseTotal + decl.modTotal + flatMod + statusAtk + ceHoldAtk + activelyDodgeAtk
                               - (isFeintRoll ? locPenalty : 0)
                               + reachAdjacentChip + physiqueChip + rangedPenaltyChip;
            const shotFormula  = shotGrandMod ? `1d10 + ${shotGrandMod}` : `1d10`;

            /* Status breakdown chips — show ONLY the attacker's own status
             * mods (which DO fold into the roll). The old code also showed
             * "Target Grappled -2" chips on the attacker's card as
             * "informational", but users reasonably read those as their
             * own penalty (they aren't — the target's defense mods land on
             * the target's defense roll). Dropped for clarity per user
             * report; the DC field already reflects target-side context. */
            const attackerStatusChips = breakdownStatusMods(this, "attack");
            /* CE contextual mod chip — surfaces "Grappling -2" / "Pinning -3"
             * / "Grappling + Pinning -5" on the attacker's own card so the
             * player + GM can read WHY the roll dropped. Null when the
             * carve-out fires (attack IS against the held partner) or when
             * CE is off. */
            const ceHoldChip = contextualPhysicalChip(this, _defenderActor);
            if (ceHoldChip) attackerStatusChips.push(ceHoldChip);
            if (activelyDodgeAtk) attackerStatusChips.push({ label: "Target Actively Dodging", value: "-2" });
            const targetStatusChips   = [];
            const shotChips = [
                ...baseChipsFor(prof),
                /* Range chip on any throw shot — surfaces the weapon's
                 * range field prominently on the card (was previously
                 * only in the subtitle "· Range BODY×3" text run).
                 * Filtered upstream: sentinels like N/A never land here. */
                throwRangeStr ? { label: "Range", value: throwRangeStr } : null,
                /* decl.chips already carries the Feint (+3) and
                 * Pirouette pills from the dialog's pre-roll compute
                 * — spreading them here is enough. */
                ...decl.chips
                    .filter(c => !(isFeintRoll && c.label === loc.label))   // drop called-shot pen on the feint roll
                    .map(c => ({ label: c.label, value: signed(c.value) })),
                flatMod ? { label: "Atk Mod", value: signed(flatMod) } : null,
                ...attackerStatusChips,
                ...targetStatusChips,
                dc != null ? { label: "DC", value: dc } : null
            ].filter(Boolean);
            /* Hit location is now its own dedicated block on the card — see
             * attackRollFlavor's `hitLocation` param. Built only for melee/
             * ranged shots that actually use a hit location (not feints,
             * not inanimate location:none). */
            const hitLocationInfo = (!isFeintRoll && loc.mode !== "none")
                ? {
                    label:     locLabel,
                    multLabel: locMult && locMult !== 1
                        ? `× ${locMult} dmg`
                        : ""
                  }
                : null;

            const ammoTag = (isBow && shotAmmo) ? ` — ${shotAmmo.name}` : "";
            // A feint is a single Deceit roll — its card reads "Feint", not the
            // weapon name, and never carries the multi-attack "(n/m)" tag.
            // Bash is a CE brawling shove — retitle the card so the reader
            // sees "Bash" front-and-centre (the strike-note explains the
            // rest). Other alt-skill strikes still fall through to the
            // normal weapon-name title.
            const weaponName = isFeintRoll
                ? game.i18n.localize("WITCHER.Attack.StrikeFeint")
                : decl.strike === "bash"
                    ? game.i18n.localize("WITCHER.CombatExtended.Action.Bash")
                    : (attacks > 1)
                        ? `${shotWeapon.name} (${i + 1}/${attacks})${ammoTag}`
                        : `${shotWeapon.name}${ammoTag}`;
            /* Fold the defender's pre-roll choice into the card note so the
             * attacker can see what they're rolling against. Defender's own
             * card (the defense roll) posts independently from defendWith /
             * rollDodge on their client. */
            const defChoice = decl?._defenseChoice;
            const defenseLine = defChoice && defChoice.action && defChoice.action !== "none"
                ? `Defender chose ${defChoice.action.charAt(0).toUpperCase() + defChoice.action.slice(1)}${defChoice.timedOut ? " (auto)" : ""}.`
                : defChoice?.action === "none"
                    ? `Defender takes the hit${defChoice.timedOut ? " (no response — auto)" : ""}.`
                    : "";
            /* Target-status info line. The math already reaches the
             * defender through their own defense roll (their card
             * shows the fold + explains why). We surface a compact,
             * clearly-informational summary here so the attacker can
             * see WHY their DC is what it is without having to open
             * the target's sheet. Prefixed "Target:" and formatted
             * with a signed value + brief label so it can't be
             * confused with an attacker-side modifier. */
            const targetStatusInfo = _defenderActor && _defenderActor !== this
                ? breakdownStatusMods(_defenderActor, "defense")
                    .map(c => `${c.label} ${c.value}`)
                    .join(", ")
                : "";
            const targetStatusLine = targetStatusInfo
                ? `Target: ${targetStatusInfo} to defense`
                : "";
            const composedNote = [strikeNote, defenseLine, reachAdjacentNote, targetStatusLine].filter(Boolean).join(" — ");
            const flavor = attackRollFlavor({
                actorName: this.name,
                weaponName,
                weaponUuid: weapon?.uuid ?? "",
                subtitle,
                hitLocation: hitLocationInfo,
                chips: shotChips,
                qualities,
                qualityKeys:   riderPayload.keys,
                qualityValues: riderPayload.values,
                note: composedNote,
                damage: { display: shotDamage.display, formula: shotDamage.formula, silverFormula: shotDamage.silverFormula, types: types.join(" · "), typeKeys, locMult, locLabel: loc.label, locKey: loc.key, strike: decl.strike ?? "normal" }
            });
            /* Fumble category for the auto-fumble dispatch. Ranged
             * attacks (fired or thrown) land on the ranged table; melee
             * strikes on armed; a Deceit feint isn't a weapon strike so
             * it falls under unarmed (Deceit isn't in the RAW fumble
             * table but the closest neighbor keeps outcomes sane). */
            const shotFumbleCategory = isFeintRoll
                ? "unarmedAttack"
                : (firedRanged || isThrowStrike ? "rangedAttack" : "meleeAttack");
            result = await extendedRoll(
                shotFormula,
                {
                    speaker, flavor,
                    /* Stamp the attack total + engagement id + chat
                     * category on this chat message so:
                     *   - the damage button (same message) can read totals
                     *   - matching defense card can be looked up
                     *   - chat filter routes it to Combat Logs
                     *
                     * defenderUuid is stamped for Witchers Reborn — Manticore
                     * · Stand Aside: the render hook needs to know who the
                     * declared target is so a nearby Manticore's owner can
                     * see whether the redirect rider is available. */
                    flags: (r) => ({
                        [SYSTEM_ID]: {
                            category: "combat",
                            ...(decl._engagementId
                                ? { engagementId: decl._engagementId, attackTotal: r.total }
                                : {}),
                            ...(_defenderActor?.uuid
                                ? { defenderUuid: _defenderActor.uuid }
                                : {}),
                            /* Witchers Reborn — Manticore · Stand Aside needs
                             * enough attack metadata to open a fresh defense
                             * prompt for the intervening Manticore. Stamp
                             * attacker + weapon + strike + hit-location on
                             * the card so the rider handler can call
                             * requestDefenseFromOwner without scraping DOM. */
                            attackerUuid:      this.uuid,
                            attackerName:      this.name,
                            attackWeaponUuid:  shotWeapon?.uuid ?? "",
                            attackWeaponName:  shotWeapon?.name ?? "",
                            attackWeaponImg:   shotWeapon?.img  ?? "",
                            attackKind:        decl.strike ?? "normal",
                            attackHitLocation: loc?.key ?? null
                        }
                    })
                },
                {
                    ...(dc != null ? { threshold: dc } : {}),
                    fumbleCategory: shotFumbleCategory
                }
            );

            /* Feint housekeeping — Core p.163 (RAW) / CE rework: the
             * attacker's roll (Deceit under RAW, weapon skill under CE)
             * is opposed by the target's Awareness (INT + Awareness
             * rank + d10). The defense-prompt path is bypassed for
             * feints (see `_willPrompt` at ~line 2188), so we roll the
             * Awareness here on the attacker's client and fold the
             * result into decl._defenseChoice. The standard verdict
             * pass then picks up `action="awareness"` + defenseTotal +
             * defenseChips and renders them like any other defense.
             *
             * If there's no defender to feint (`_defenderActor` null),
             * refuse — a feint requires a mark. Missing the target
             * shouldn't silently auto-succeed.
             *
             * The Awareness dice-tray is rendered and appended to the
             * attack card so the player can SEE the opposed check
             * happened (previously only the total showed on the
             * verdict line, which read as "no opposed check at all"). */
            let feintSucceeded = true;
            if (isFeintRoll) {
                if (!_defenderActor) {
                    ui?.notifications?.warn?.("Feint needs a target — pick a mark first.");
                    return null;
                }
                if (decl?._defenseChoice) {
                    const sk        = _defenderActor.system?.skills?.int?.awareness ?? {};
                    const statVal   = Number(_defenderActor.system?.stats?.int?.value) || 0;
                    const rank      = Number(sk.value) || 0;
                    const modifier  = Number(sk.modifier) || 0;
                    const skillMod  = statVal + rank + modifier;
                    const formula   = skillMod >= 0 ? `1d10 + ${skillMod}` : `1d10 - ${Math.abs(skillMod)}`;
                    try {
                        const awarenessRoll = await new Roll(formula).evaluate();
                        const total = Number(awarenessRoll.total) || 0;
                        feintSucceeded = Number(result?.total) > total;
                        /* Mutate the underlying decl._defenseChoice object —
                         * the const `defChoice` binding above shares this
                         * reference, so the take-it fallback (which checks
                         * `action === "none"`) skips over this shot and the
                         * verdict pass reads the real Awareness total. */
                        decl._defenseChoice.action = "awareness";
                        decl._defenseChoice.defenseTotal = total;
                        decl._defenseChoice.defenseChips = [
                            { label: "INT",  value: statVal },
                            { label: "Rank", value: rank },
                            modifier ? { label: "Mod", value: (modifier >= 0 ? "+" : "") + modifier } : null
                        ].filter(Boolean);
                        decl._defenseChoice._dc10Pass = false;
                        decl._defenseChoice.timedOut = false;
                        /* Render the target's Awareness roll as a
                         * proper dice tray on the attack card so the
                         * opposed check is unambiguously visible. */
                        if (result?.message) {
                            try {
                                const diceHtml = await awarenessRoll.render();
                                const fragment =
                                    `<div class="wdm-attack-rider">` +
                                        `<i class="fa-solid fa-eye"></i> ` +
                                        `<strong>${esc(_defenderActor.name)}</strong> — Awareness (INT+${rank}${modifier ? (modifier >= 0 ? `+${modifier}` : `${modifier}`) : ""}) = <b>${total}</b>` +
                                        diceHtml +
                                    `</div>`;
                                await appendAttackResult(result.message, { fragment });
                            } catch (_) { /* dice render is a nicety */ }
                        }
                    } catch (err) {
                        console.warn("witcher-ttrpg-death-march | feint Awareness roll failed", err);
                    }
                }
            }

            try {
                if (isFeintRoll && feintSucceeded) {
                    /* Store the feinted target's UUID (not just `true`)
                     * so the +3 is gated on the follow-up attack going
                     * against the SAME target. A swing at anyone else
                     * still burns the flag but doesn't get the bonus. */
                    await this.setFlag(SYSTEM_ID, "feintAdvantage", _defenderActor?.uuid ?? "");
                    /* Stamp the summary message's uuid onto a flag so the
                     * Pirouette rider handler (which fires later, when
                     * the user clicks the button) can rewrite this line
                     * to reflect the boosted bonus. */
                    const summaryMsg = await ChatMessage.create({
                        speaker,
                        content: `<em><strong>${esc(this.name)}</strong> feints — next attack against <strong>${esc(_defenderActor?.name ?? "target")}</strong> at <strong>+3</strong>.</em>`,
                        flags: { [SYSTEM_ID]: { category: "combat", feintSummary: true, feintTargetName: _defenderActor?.name ?? "target" } }
                    });
                    if (summaryMsg?.id) {
                        await this.setFlag(SYSTEM_ID, "wr.feintSummaryMsgId", summaryMsg.id);
                    }
                    /* Witchers Reborn — Wolf · Pirouette (heroic): after
                     * a successful feint, the attacker may spend N
                     * adrenaline dice to stack N further points of
                     * defensive penalty on the target's next defense.
                     * Rider button lands on the feint's chat card. */
                    try {
                        if (wrHeroic(this) === "pirouette" && result?.message) {
                            const label = "Pirouette (spend adrenaline — boost feint bonus)";
                            const rider =
                                `<div class="wdm-attack-rider wdm-wr-rider" data-wr-rider="pirouette">` +
                                    `<button type="button" class="wdm-attack-damage-roll" data-action="wdm-pirouette" ` +
                                        `data-attacker-uuid="${esc(this.uuid)}">` +
                                        `<i class="fa-solid fa-shoe-prints"></i> ${esc(label)}` +
                                    `</button>` +
                                `</div>`;
                            await appendAttackResult(result.message, { fragment: rider });
                        }
                    } catch (err) {
                        console.warn("witcher-ttrpg-death-march | Pirouette rider emit failed", err);
                    }
                } else if (isFeintRoll && !feintSucceeded) {
                    /* Failed feint — target saw through it. No flag,
                     * no +3 next attack. Post a brief note so the
                     * outcome is legible on the card. */
                    await ChatMessage.create({
                        speaker,
                        content: `<em><strong>${esc(this.name)}</strong> feints — target saw through it (no advantage).</em>`,
                        flags: { [SYSTEM_ID]: { category: "combat" } }
                    });
                } else if (feintAdv) {
                    await this.unsetFlag(SYSTEM_ID, "feintAdvantage");
                    /* Pirouette bonus + summary-msg-id ride on the same
                     * feintAdvantage consumption window — clear all
                     * together so the next feint starts fresh. */
                    if (this.getFlag(SYSTEM_ID, "wr.pirouetteBonus")) {
                        await this.unsetFlag(SYSTEM_ID, "wr.pirouetteBonus");
                    }
                    if (this.getFlag(SYSTEM_ID, "wr.feintSummaryMsgId")) {
                        await this.unsetFlag(SYSTEM_ID, "wr.feintSummaryMsgId");
                    }
                }
            } catch (err) {
                console.warn("witcher-ttrpg-death-march | feint flag housekeeping failed", err);
            }

            /* "Take it" / closed defense window / timed-out prompt → roll
             * vs flat DC 10. RAW Core p.161: a defender who can't (or
             * won't) react is treated as Stunned — attacker only needs
             * to beat 10. UNCONDITIONALLY overrides any prior
             * defenseTotal (an earlier version checked Number.isFinite,
             * but Number(null) === 0 which IS finite, so the check
             * silently skipped take-it cases and the verdict compared
             * the attack roll against 0 instead of 10). */
            if (
                defChoice &&
                (defChoice.action === "none" || defChoice.timedOut === true)
            ) {
                defChoice.defenseTotal = 10;
                defChoice._dc10Pass = true;   // tag for the verdict label below
            }

            /* Helpless-target fold: pinned / paralyzed / stunned /
             * unconscious targets are hit on the clause's incomingDC (10
             * for every helpless status in the catalog). Applied AFTER
             * the "no defense" fold above so a target who picked dodge
             * with a lucky 20 is still capped at 10 while pinned — the
             * defense roll doesn't override the RAW helpless floor. */
            try {
                const { incomingAttackDC } = await import("../../mechanics/statusEngine.mjs");
                const helplessDC = incomingAttackDC(_defenderActor);
                if (typeof helplessDC === "number") {
                    const prior = Number(defChoice?.defenseTotal);
                    defChoice ??= { action: "none" };
                    defChoice.defenseTotal = Number.isFinite(prior)
                        ? Math.min(prior, helplessDC)
                        : helplessDC;
                    defChoice._helplessDC = helplessDC;
                }
            } catch (_) { /* ignore — pinned floor is a nicety, not load-bearing */ }

            /* Unified-card verdict pass: now that the attack roll resolved
             * and we know the defender's total too, fold the defense roll
             * (the standalone card was suppressed for engagement-linked
             * defenses) into the attack card AND append the HIT/MISS/CRIT
             * verdict. Miss strips the damage button entirely. Stunned
             * targets show DC 10 instead of a defense roll. */
            // defChoice was declared earlier in this iteration for the
            // pre-roll defender-line in the card note; reuse it here.
            const defenseTotal = Number(defChoice?.defenseTotal);
            const hasDefense = Number.isFinite(defenseTotal);
            const isFumble   = !!result?.fumble;
            /* Render the verdict block when we have either a defender
             * comparison OR a fumble. Fumbles always show — they need to
             * stand out as the most visible thing on the card (per user
             * spec: "Move fumble warning to the same place as MISS.
             * Fumbles need to be more clear"). */
            if (result?.message && Number.isFinite(result.total) && (hasDefense || isFumble)) {
                /* Fumble does NOT auto-miss — the actual roll math still
                 * decides hit vs miss. A nat 1 + huge bonuses (after the
                 * downward implode chain) can still beat the defender;
                 * conversely a low non-fumble roll can still miss. The
                 * FUMBLE badge is a separate banner stacked on top of
                 * the normal verdict so the player sees BOTH: did the
                 * swing land, AND did they fumble (which triggers the
                 * fumble-table consequence regardless). */
                const delta = result.total - (hasDefense ? defenseTotal : 0);
                const sev = critSeverityFromDelta(delta);
                const isStunnedHit = defChoice?.action === "stunned";
                const isDc10Pass   = !!defChoice?._dc10Pass;
                /* Defense type label — capitalize (Parry/Block/Dodge/Reposition/Take it).
                 * "Take it" / "stunned" / "none" each get their own friendlier wording. */
                const defActionRaw = String(defChoice?.action ?? "");
                const defActionTitle = ({
                    "parry": "Parry", "block": "Block", "dodge": "Dodge",
                    "reposition": "Reposition", "none": "Took the hit",
                    "stunned": "Stunned"
                })[defActionRaw] ?? (defActionRaw.charAt(0).toUpperCase() + defActionRaw.slice(1));
                /* Defender chip breakdown — renders the same guard /
                 * status / weapon-quality mods the defender's own chat
                 * card WOULD show if it weren't suppressed for
                 * engagement-linked defenses. Structured `defenseChips`
                 * come from defendWith / defendBySkill through the
                 * socket relay. Rendered inside the defense block below
                 * the "Defender chose X → total" line. */
                const chipRowHtml = (Array.isArray(defChoice?.defenseChips) && defChoice.defenseChips.length)
                    ? `<div class="wdm-attack-defense-chips" style="display:flex;flex-wrap:wrap;gap:3px;margin-top:3px;">${
                        defChoice.defenseChips
                            .filter(c => c && c.value != null && c.value !== "")
                            .map(c => `<span class="wdm-chip wdm-chip-def"><span class="wdm-chip-k">${esc(c.label)}</span><span class="wdm-chip-v">${esc(c.value)}</span></span>`)
                            .join("")
                    }</div>`
                    : "";
                const defenseLabel = hasDefense
                    ? ((isStunnedHit || isDc10Pass)
                        ? `<div class="wdm-attack-defense"><span class="wdm-attack-defense-k">Defense</span> <span class="wdm-attack-defense-v"><b>${isStunnedHit ? "Stunned" : (defChoice?.timedOut ? "No response" : "Took the hit")}</b> — DC <b>10</b></span></div>`
                        : `<div class="wdm-attack-defense"><span class="wdm-attack-defense-k">Defense</span> <span class="wdm-attack-defense-v"><b>${esc(defActionTitle)}</b> → <b>${defenseTotal}</b></span>${chipRowHtml}${defChoice?.defenseBody ? `<div class="wdm-attack-defense-body">${defChoice.defenseBody}</div>` : ""}</div>`)
                    : "";
                const verdictClass = delta > 0
                    ? (sev ? `is-hit is-crit is-crit-${sev}` : "is-hit")
                    : "is-miss";
                const verdictHead = delta > 0
                    ? (sev ? `HIT — ${sev.toUpperCase()} CRIT` : "HIT")
                    : "MISS";
                const verdictSub  = delta > 0
                    ? `attacker beat by ${delta}`
                    : delta === 0
                        ? `tie — defender wins`
                        : `defender beat by ${Math.abs(delta)}`;
                const verdictRolls = `<span class="wdm-attack-verdict-rolls">attack <b>${result.total}</b>${hasDefense ? ` vs ${(isStunnedHit || isDc10Pass) ? "DC <b>10</b>" : `defense <b>${defenseTotal}</b>`}` : ""}</span>`;
                /* Fumble banner — separate single-row block ABOVE the
                 * HIT/MISS verdict. Red palette + horizontal layout so
                 * the head doesn't wrap vertically the way a verdict
                 * head does in the narrow grid column. */
                const fumbleBanner = isFumble
                    ? `<div class="wdm-attack-fumble"><i class="fa-solid fa-triangle-exclamation"></i> <span class="wdm-attack-fumble-k">FUMBLE</span> <span class="wdm-attack-fumble-v">natural 1 — consult the fumble table</span></div>`
                    : "";
                const verdictHtml =
                    `${fumbleBanner}` +
                    `${defenseLabel}` +
                    `<div class="wdm-attack-verdict ${verdictClass}">` +
                        `<span class="wdm-attack-verdict-head">${verdictHead}</span>` +
                        `<span class="wdm-attack-verdict-sub">${verdictSub}</span>` +
                        verdictRolls +
                    `</div>`;
                /* Body Block (Brawling) arm-redirect note. When the
                 * defender picked brawlBlock AND their total beat the
                 * attacker (delta <= 0), the strike is redirected to a
                 * random arm — SP + damage apply to that arm instead of
                 * the location the attacker rolled. We surface the
                 * redirected location as a note so the GM applies
                 * damage against arm SP (the damage roll still comes
                 * from the button). When brawlBlock LOSES, the strike
                 * lands normally at the original location. */
                let brawlBlockNote = "";
                if (defChoice?.action === "brawlBlock" && delta <= 0 && hasDefense) {
                    const arm = Math.random() < 0.5 ? "leftArm" : "rightArm";
                    const armLabel = arm === "leftArm" ? "Left arm" : "Right arm";
                    brawlBlockNote = `<div class="wdm-attack-note" style="color:#8b8;"><i class="fa-solid fa-hand-fist"></i> <strong>Body Block succeeds</strong> — strike redirected to <strong>${armLabel}</strong>. Apply damage against arm SP (×½ multiplier).</div>`;
                }
                /* Scoring a crit banks 1 adrenaline for the attacker
                 * (RAW Core p.175-176), capped at BODY. Fires here in the
                 * auto-flow BEFORE the damage button is offered, so it
                 * can be spent on Deadly Focus (or any other adrenaline
                 * use) before rolling damage. Mirrors the manual dock
                 * Critical flow's grantCritAdrenaline behavior; the two
                 * paths are now consistent. */
                if (delta > 0 && sev && isAdrenalineEnabled()) {
                    try {
                        const cur = Number(this.system?.adrenaline?.value);
                        const cap = Number(this.system?.stats?.body?.value) || 0;
                        if (Number.isFinite(cur)) {
                            const next = Math.min(cur + 1, cap);
                            if (next > cur) {
                                await this.update({ "system.adrenaline.value": next });
                            }
                        }
                    } catch (err) {
                        console.warn("witcher-ttrpg-death-march | auto-crit adrenaline grant failed", err);
                    }
                }

                /* Witchers Reborn — Cat · Deadly Focus (heroic): when a
                 * crit lands AND the attacker owns the heroic AND the
                 * severity is upgradeable, append a rider to the attack
                 * card BEFORE the damage button. Clicking it debits
                 * adrenaline and rewrites the attack msg's critSeverity
                 * flag, so the subsequent damage roll picks up the
                 * upgraded +N crit bonus. */
                let deadlyFocusRider = "";
                if (delta > 0 && sev && wrHeroic(this) === "deadlyFocus") {
                    const nextSev = { simple: "complex", complex: "difficult", difficult: "deadly" }[sev];
                    const cost    = { simple: 1, complex: 2, difficult: 3 }[sev];
                    if (nextSev && cost) {
                        const nextLabel = nextSev[0].toUpperCase() + nextSev.slice(1);
                        deadlyFocusRider =
                            `<div class="wdm-attack-rider wdm-wr-rider" data-wr-rider="deadlyFocus">` +
                                `<button type="button" class="wdm-attack-damage-roll" data-action="wdm-deadly-focus" ` +
                                    `data-attacker-uuid="${esc(this.uuid)}" ` +
                                    `data-attack-msg-uuid="${esc(result.message.uuid)}" ` +
                                    `data-next-severity="${esc(nextSev)}" ` +
                                    `data-ae-cost="${esc(String(cost))}">` +
                                    `<i class="fa-solid fa-crosshairs"></i> Deadly Focus — upgrade to ${esc(nextLabel)} (${esc(String(cost))} adrenaline)` +
                                `</button>` +
                            `</div>`;
                    }
                }

                /* Witchers Reborn — Bear · Forceful Blow: on a strong-strike
                 * hit, emit an action button next to Roll Damage. Clicking
                 * it debits 5 STA and rolls the damage formula twice, keeps
                 * the higher, and applies. Carries the same data attributes
                 * as the Roll Damage button so the pipeline downstream
                 * (SP / crit / oil / silver) folds the same way. */
                let forcefulBlowRider = "";
                /* Both the RAW strike key ("strong") AND the Combat
                 * Extended rename ("strongAttack") count as a strong
                 * strike. Data-driven check would be nicer but the two
                 * keys are stable enough to hardcode. */
                const isStrongStrike = decl.strike === "strong" || decl.strike === "strongAttack";
                if (delta > 0 && isStrongStrike && hasWRPerk(this, "forcefulBlow")) {
                    /* Extract individual data-* attributes from the Roll
                     * Damage button so Forceful Blow inherits formula,
                     * silver, types, location, qualities, weaponUuid.
                     * Direct attribute extraction (not raw string paste)
                     * avoids duplicating type/class on the new button. */
                    const cur = String(result.message.content ?? "");
                    const btnMatch = cur.match(/<button[^>]*data-action="wdm-roll-damage"[^>]*>/);
                    if (btnMatch) {
                        const btnHtml = btnMatch[0];
                        const grab = (attr) => {
                            const m = btnHtml.match(new RegExp(`${attr}="([^"]*)"`));
                            return m ? m[1] : "";
                        };
                        const dataAttrs = [
                            "data-formula", "data-types", "data-loc-mult",
                            "data-loc-label", "data-loc-key", "data-strike",
                            "data-silver-formula", "data-weapon-uuid",
                            "data-quality-keys", "data-quality-values"
                        ].map(a => {
                            const v = grab(a);
                            return v ? `${a}="${v}"` : "";
                        }).filter(Boolean).join(" ");
                        forcefulBlowRider =
                            `<div class="wdm-attack-rider wdm-wr-rider" data-wr-rider="forcefulBlow">` +
                                `<button type="button" class="wdm-attack-damage-roll" data-action="wdm-forceful-blow" ` +
                                    `data-attacker-uuid="${esc(this.uuid)}" ${dataAttrs}>` +
                                    `<i class="fa-solid fa-hammer"></i> Forceful Blow — Roll Damage ×2, keep higher (5 STA)` +
                                `</button>` +
                            `</div>`;
                    }
                }

                const verdictHtmlWithBrawl = verdictHtml + brawlBlockNote + deadlyFocusRider + forcefulBlowRider;
                try {
                    const cur = String(result.message.content ?? "");
                    let next = cur;
                    if (delta > 0) {
                        // Hit: insert defense + verdict ABOVE the damage button
                        // block so the GM sees the comparison before clicking.
                        next = cur.includes("wdm-attack-damage")
                            ? cur.replace(/<div class="wdm-attack-damage">/, `${verdictHtmlWithBrawl}<div class="wdm-attack-damage">`)
                            : `${cur}${verdictHtmlWithBrawl}`;
                    } else if (defChoice?.action === "brawlBlock" && brawlBlockNote) {
                        /* Brawl-block success: not a plain MISS — the strike
                         * still lands on the arm. Keep the damage block AND
                         * append the redirect note so the GM can apply
                         * damage against arm SP. */
                        next = cur.includes("wdm-attack-damage")
                            ? cur.replace(/<div class="wdm-attack-damage">/, `${verdictHtmlWithBrawl}<div class="wdm-attack-damage">`)
                            : `${cur}${verdictHtmlWithBrawl}`;
                    } else {
                        // Miss: strip the damage block entirely, keep defense+verdict.
                        next = cur.replace(/<div class="wdm-attack-damage">[\s\S]*?<\/div>(<div class="wdm-attack-damage-note">[\s\S]*?<\/div>)?/, verdictHtmlWithBrawl);
                        if (next === cur) next = `${cur}${verdictHtmlWithBrawl}`;
                    }
                    /* Stamp the resolved defense + crit severity onto the
                     * attack message's flags too. The damage button (rolled
                     * later, possibly after the engagement-linked defense
                     * "card" has scrolled off / never posted because it was
                     * suppressed) reads these directly instead of having to
                     * scan game.messages for a defense card by engagementId.
                     * This was the root cause of "crit confirmed but armor
                     * soaked everything" — without these flags the damage
                     * pipeline saw critBonus=0 and stopped at Stage 3 SP. */
                    const flagPatch = {
                        defenseTotal,
                        critSeverity: sev ?? null,
                        critDelta:    delta
                    };
                    if (next !== cur) {
                        await result.message.update({
                            content: next,
                            [`flags.${SYSTEM_ID}`]: flagPatch
                        });
                    } else {
                        await result.message.update({ [`flags.${SYSTEM_ID}`]: flagPatch });
                    }
                    /* Seed the master summary with the verdict + optional
                     * fumble flag. This is the FIRST appendAttackResult
                     * call on the card, so the outer wrap is built here.
                     *
                     * For HITs (where the damage button exists in the
                     * body): EXTRACT the button HTML and surface it as
                     * the summary's action slot. That way the user can
                     * click Roll Damage WITHOUT expanding the collapsed
                     * card — the button is visible on the one-liner. */
                    const isHit = !isFumble && delta > 0;
                    let summaryActionHtml = null;
                    if (isHit) {
                        try {
                            const tmp = document.createElement("div");
                            tmp.innerHTML = String(result.message.content ?? "");
                            const damageBtn = tmp.querySelector('button[data-action="wdm-roll-damage"]');
                            if (damageBtn) {
                                /* MOVE the button to the summary action
                                 * slot (clone for the slot, remove the
                                 * body original + its wrapper). Two
                                 * separate copies of the same button in
                                 * message content meant the chat-preview
                                 * rendered TWO Roll Damage proxies. */
                                const clone = damageBtn.cloneNode(true);
                                clone.classList.add("wdm-card-sum-roll");
                                summaryActionHtml = clone.outerHTML;
                                /* Strip the body copy + its .wdm-attack-damage
                                 * wrapper from the persisted content. */
                                const bodyWrap = damageBtn.closest(".wdm-attack-damage");
                                if (bodyWrap) bodyWrap.remove();
                                else damageBtn.remove();
                                tmp.querySelectorAll(".wdm-attack-damage-note").forEach(n => n.remove());
                                /* Persist the stripped content back to
                                 * the message so chat-preview's button
                                 * scan only finds the summary-slot copy. */
                                await result.message.update({ content: tmp.innerHTML });
                            }
                        } catch (_) { /* best-effort */ }
                    }
                    const verdictLabel = isFumble
                        ? "FUMBLE"
                        : delta > 0
                            ? (sev ? `${sev.toUpperCase()} CRIT` : "HIT")
                            : "MISS";
                    const verdictKind = isFumble
                        ? "fumble"
                        : delta > 0
                            ? (sev ? "crit" : "hit")
                            : "miss";
                    /* Verdict chip first. */
                    await appendAttackResult(result.message, {
                        summaryAdd: { label: verdictLabel, kind: verdictKind }
                    });
                    /* Hit-location chip — added IMMEDIATELY AFTER the
                     * verdict so the user knows what got hit BEFORE
                     * clicking Roll Damage. Only meaningful on HITs
                     * (misses don't damage a location). Skipped when
                     * the shot has no location (inanimate, feint). */
                    if (delta > 0 && hitLocationInfo?.label) {
                        await appendAttackResult(result.message, {
                            summaryAdd: { label: hitLocationInfo.label, kind: "info", icon: "fa-bullseye" }
                        });
                    }
                    /* Action slot last — the Roll Damage button sits
                     * on the right side of the summary line. */
                    if (summaryActionHtml !== null) {
                        await appendAttackResult(result.message, {
                            summaryAction: summaryActionHtml
                        });
                    }
                } catch (err) {
                    console.warn("witcher-ttrpg-death-march | verdict patch failed", err);
                }

                /* Parry auto-stagger (RAW Core p.164): when the defender
                 * chose Parry AND the parry beat the attack roll, the
                 * attacker is staggered. Notice folds INTO the attack
                 * card's collapsible result block so the defender's
                 * consequence sits with everything else.
                 *
                 * Witchers Reborn — Cat · Swift Recovery: the attacker is
                 * NOT staggered when their attack is parried. Guard here
                 * before the emitApplyStatus fires. */
                if (defChoice?.action === "parry" && delta <= 0 && !hasWRPerk(this, "swiftRecovery")) {
                    try {
                        await emitApplyStatus({
                            targetUuid: this.uuid,
                            statusId:   "staggered",
                            action:     "apply"
                        });
                        const fragment =
                            `<div class="wdm-attack-rider">` +
                                `<i class="fa-solid fa-shield-halved"></i> ` +
                                `<strong>${esc(_defenderActor?.name ?? "Defender")}</strong> parries — ` +
                                `<strong>${esc(this.name)}</strong> is staggered.` +
                            `</div>`;
                        await appendAttackResult(result.message, {
                            fragment,
                            summaryAdd: { label: `${this.name}: Staggered`, kind: "status", icon: "fa-shield-halved" }
                        });
                    } catch (err) {
                        console.warn("witcher-ttrpg-death-march | parry auto-stagger failed", err);
                    }
                }

                /* Witchers Reborn — Manticore · Riposte: on a successful
                 * shield parry, the defender may spend 5 STA to make an
                 * immediate shield bash or single weapon attack against
                 * the attacker. Renders two rider buttons — bash (uses
                 * the parrying shield) and strike (uses the defender's
                 * first equipped melee weapon). Both target the attacker
                 * automatically and skip the defender's action-slot spend
                 * (they set the `wr.riposteFreeAttack` flag which
                 * spendActionSlot consumes on the next "Attack:" label). */
                if (defChoice?.action === "parry" && delta <= 0 && defChoice?.itemId && _defenderActor) {
                    try {
                        const parryItem = _defenderActor?.items?.get?.(defChoice.itemId);
                        const parriedWithShield = parryItem?.type === "shield";
                        if (parriedWithShield && hasWRPerk(_defenderActor, "riposte")) {
                            /* One button per weapon/shield the defender is
                             * holding — accepts either `system.equipped: true`
                             * OR a `system.slot` in {right, left, quick, both}.
                             * Weapons in this codebase can be marked "held" via
                             * either path (some flows write slot without flipping
                             * equipped, e.g. Fast Draw); using both keeps the
                             * list consistent with the character sheet. */
                            const HELD_SLOTS = new Set(["right", "left", "quick", "both"]);
                            const equippedHandItems = (_defenderActor.items?.contents ?? [])
                                .filter(it => {
                                    if (it.type !== "weapon" && it.type !== "shield") return false;
                                    if (it.system?.equipped) return true;
                                    return HELD_SLOTS.has(String(it.system?.slot ?? ""));
                                });
                            const buttons = equippedHandItems.map(it =>
                                `<button type="button" class="wdm-attack-damage-roll" data-action="wdm-riposte-strike" ` +
                                    `data-actor-uuid="${esc(_defenderActor.uuid)}" ` +
                                    `data-weapon-uuid="${esc(it.uuid)}" ` +
                                    `data-attacker-uuid="${esc(this.uuid)}" ` +
                                    `data-sta-cost="5">` +
                                    `${esc(it.name)} (5 STA)` +
                                `</button>`
                            ).join(" ");
                            if (buttons) {
                                const fragment =
                                    `<div class="wdm-attack-rider wdm-wr-rider" data-wr-rider="riposte">` +
                                        `<i class="fa-solid fa-shield-heart"></i> ` +
                                        `<strong>Riposte</strong> — ` +
                                        `${esc(_defenderActor.name)} may strike back at ${esc(this.name)}. ` +
                                        buttons +
                                    `</div>`;
                                await appendAttackResult(result.message, { fragment });
                            }
                        }
                    } catch (err) {
                        console.warn("witcher-ttrpg-death-march | Riposte rider post failed", err);
                    }
                }

                /* Hold-status apply (CE Clinch / Chokehold / Grapple /
                 * Pin). The action carries `appliesStatus` on its
                 * definition (see data/combatExtended/actions.mjs).
                 * Fires only on a HIT (delta > 0); a missed hold
                 * doesn't latch. Under the bidirectional model,
                 * applyHoldLink stamps the status on BOTH attacker and
                 * defender. Escape isn't an action — the movement-
                 * break hook in holdLink.mjs clears a pair when the
                 * moved actor's distance to the partner exceeds reach. */
                try {
                    const ceTable = getActiveCombatActions?.() ?? {};
                    const actionDef = ceTable?.[decl.strike];
                    /* Read appliesStatus from the strike meta first (which
                     * came from the active strike table — RAW STRIKE_TYPES
                     * or CE table — and carries whichever entry the dialog
                     * picked). Fall back to the CE action definition for
                     * older code paths. This makes RAW-authored appliesStatus
                     * (e.g. STRIKE_TYPES.trip → "prone") fire in RAW mode. */
                    const strikeStatus = decl.strikeMeta?.appliesStatus ?? actionDef?.appliesStatus;
                    if (delta > 0 && strikeStatus && _defenderActor?.uuid) {
                        const sid = String(strikeStatus);
                        /* Hold-only ids (grappled / pinned / clinched /
                         * chokeheld) go via applyHoldLink — that adds a
                         * pair to the registry and stamps the status on
                         * both actors. Non-hold appliesStatus values
                         * (e.g. RAW Trip → prone) fall back to bare
                         * emitApplyStatus. Trip strikes carry noDamage,
                         * so no damage button fires — this verdict-block
                         * apply is the only path that stamps the status
                         * for a Trip that lands. */
                        const HOLDS = ["grappled", "pinned", "clinched", "chokeheld"];
                        if (HOLDS.includes(sid)) {
                            const { applyHoldLink } = await import("../../mechanics/holdLink.mjs");
                            await applyHoldLink(this, _defenderActor, sid);
                        } else {
                            await emitApplyStatus({
                                targetUuid: _defenderActor.uuid, statusId: sid, action: "apply"
                            });
                        }
                        const statusDef = (CONFIG.statusEffects ?? []).find(s => s.id === sid);
                        const statusLabel = statusDef?.name ? game.i18n.localize(statusDef.name) : sid;
                        const fragment =
                            `<div class="wdm-attack-rider">` +
                                `<i class="fa-solid fa-link"></i> ` +
                                `<strong>${esc(_defenderActor?.name ?? "Defender")}</strong> is now <strong>${esc(statusLabel)}</strong>.` +
                            `</div>`;
                        await appendAttackResult(result.message, {
                            fragment,
                            summaryAdd: { label: `${_defenderActor.name}: ${statusLabel}`, kind: "status", icon: "fa-link" }
                        });
                    }
                } catch (err) {
                    console.warn("witcher-ttrpg-death-march | hold-status apply failed", err);
                }

                /* CE Bash outcome — the swing landed (defender's Dodge /
                 * Reposition failed). Fire the opposed Physique roll
                 * inline, no button click required. Defender adds their
                 * equipped shield's Cover Value to their Physique. On
                 * attacker win: push BODY/3 metres via pushToken + apply
                 * Staggered when the delta hits ≥ 7. */
                if (delta > 0 && decl.strike === "bash" && _defenderActor) {
                    try {
                        await autoRollBashOutcome(this, _defenderActor, result.message);
                    } catch (err) {
                        console.warn("witcher-ttrpg-death-march | bash outcome auto-roll failed", err);
                    }
                }

                /* Disarm scatter rider (RAW Core p.166). A successful Disarm
                 * knocks the defender's weapon loose — 1d8 for compass
                 * direction, 1d6 for distance in metres. No inventory
                 * changes and no world-item placement (kept flat per user
                 * spec): the GM narrates + resolves pickup by hand. */
                if (delta > 0 && decl.strike === "disarm") {
                    try {
                        const dirRoll  = await new Roll("1d8").evaluate();
                        const distRoll = await new Roll("1d6").evaluate();
                        const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
                        const dirLabels = {
                            N: "north", NE: "northeast", E: "east", SE: "southeast",
                            S: "south", SW: "southwest", W: "west", NW: "northwest"
                        };
                        const dir = dirs[(Number(dirRoll.total) - 1) % 8];
                        const dist = Number(distRoll.total) || 0;
                        const fragment =
                            `<div class="wdm-attack-rider">` +
                                `<i class="fa-solid fa-hand-fist"></i> ` +
                                `<strong>${esc(_defenderActor?.name ?? "Defender")}</strong>'s weapon is knocked ` +
                                `<strong>${dist}m ${esc(dirLabels[dir] ?? dir)}</strong> ` +
                                `<span style="opacity:0.7;">(1d8=${dirRoll.total} → ${esc(dir)}, 1d6=${dist})</span>.` +
                            `</div>`;
                        await appendAttackResult(result.message, {
                            fragment,
                            summaryAdd: {
                                label: `Disarm: ${dist}m ${dir}`,
                                kind:  "status",
                                icon:  "fa-hand-fist"
                            }
                        });
                    } catch (err) {
                        console.warn("witcher-ttrpg-death-march | disarm scatter failed", err);
                    }
                }

                /* Block auto-reliability spend: a Block that BEAT the
                 * attack ate the hit on the weapon/shield — spend 1
                 * point of its Reliability automatically. The reliability
                 * write (+ break notice) is GM-side via socket; we
                 * also drop a folded line into the attack card here so
                 * the attacker / table sees the cost on the same card. */
                if (defChoice?.action === "block" && delta <= 0 && defChoice?.itemId) {
                    try {
                        const blockItem = _defenderActor?.items?.get?.(defChoice.itemId);
                        if (blockItem?.uuid) {
                            await emitReduceReliability({
                                itemUuid: blockItem.uuid,
                                attackMessageUuid: result.message?.uuid ?? null
                            });
                        }
                        /* Feeble / Hefty block-through riders (EO p.7).
                         * The rules engine prints a chat-card NOTE
                         * describing the half-damage / half-nonlethal
                         * implication; the GM rolls the trickle damage
                         * manually (the deterministic calculator path
                         * doesn't have a "blocked-but-half" mode and
                         * adding one would invert too many resolveDamage
                         * invariants). The note surfaces the rule so it
                         * actually fires at the table. */
                        const attkQ = new Set(weapon?.system?.effective?.qualities ?? weapon?.system?.qualities ?? []);
                        const defQ  = new Set(blockItem?.system?.effective?.qualities ?? blockItem?.system?.qualities ?? []);
                        if (attkQ.has("hefty")) {
                            const frag =
                                `<div class="wdm-attack-rider">` +
                                    `<i class="fa-solid fa-weight-hanging"></i> ` +
                                    `<strong>Hefty block-through</strong>: ` +
                                    `<em>${esc(_defenderActor?.name ?? "Defender")}</em> takes half the rolled damage as non-lethal (EO p.7).` +
                                `</div>`;
                            await appendAttackResult(result.message, {
                                fragment: frag,
                                summaryAdd: { label: "Hefty: half non-lethal", kind: "info", icon: "fa-weight-hanging" }
                            });
                        } else if (defQ.has("feeble") && !attkQ.has("feeble")) {
                            const frag =
                                `<div class="wdm-attack-rider">` +
                                    `<i class="fa-solid fa-shield-halved"></i> ` +
                                    `<strong>Feeble block</strong>: ` +
                                    `<em>${esc(_defenderActor?.name ?? "Defender")}</em> still takes half damage despite the block (EO p.7).` +
                                `</div>`;
                            await appendAttackResult(result.message, {
                                fragment: frag,
                                summaryAdd: { label: "Feeble: half damage", kind: "info", icon: "fa-shield-halved" }
                            });
                        }
                        /* Charge rider (RAW Core): "If the attack is
                         * blocked you can make a Physique check against
                         * the opponent's Physique roll to knock the
                         * target prone." Attach a button on the attack
                         * card when the strike WAS charge AND the block
                         * beat the attacker. Clicking opens a two-way
                         * opposed 1d10 + Physique roll; attacker wins
                         * → prone status applied to defender. */
                        if (decl.strike === "charge") {
                            const chargeFrag =
                                `<div class="wdm-attack-rider" data-charge-rider="1">` +
                                    `<button type="button" class="wdm-attack-damage-roll" ` +
                                        `data-action="wdm-charge-prone" ` +
                                        `data-attacker-uuid="${esc(this.uuid)}" ` +
                                        `data-target-uuid="${esc(_defenderActor?.uuid ?? "")}">` +
                                        `<i class="fa-solid fa-person-falling"></i> ` +
                                        `Attempt to knock prone (Physique vs Physique)` +
                                    `</button>` +
                                `</div>`;
                            await appendAttackResult(result.message, {
                                fragment: chargeFrag,
                                summaryAdd: { label: "Charge blocked: prone check available", kind: "info", icon: "fa-person-falling" }
                            });
                        }

                        /* Phase 7 — Blade Catcher rider (EO p.7): when the
                         * defender Blocks with a weapon that carries the
                         * `bladeCatcher` quality, both weapons lock until
                         * an opposed Small Blades vs Physique/Sleight check.
                         * Surface as chat-card NOTE — math is GM-adjudicated. */
                        if (defQ.has("bladeCatcher") && delta <= 0) {
                            const frag =
                                `<div class="wdm-attack-rider">` +
                                    `<i class="fa-solid fa-hand-fist"></i> ` +
                                    `<strong>Blade Catcher</strong>: ` +
                                    `<em>${esc(_defenderActor?.name ?? "Defender")}</em>'s weapon locks with ` +
                                    `<em>${esc(this.name)}</em>'s. Opposed Small Blades vs Physique / Sleight of Hand to free both weapons (EO p.7).` +
                                `</div>`;
                            await appendAttackResult(result.message, {
                                fragment: frag,
                                summaryAdd: { label: "Blade Catcher: locked", kind: "info", icon: "fa-hand-fist" }
                            });
                        }
                    } catch (err) {
                        console.warn("witcher-ttrpg-death-march | block auto-reliability spend failed", err);
                    }
                }

                /* ── Phase 7 — On-hit miscellaneous riders (EO p.7-8) ──
                 *   magicalAnchoring  — forces an intangible/invisible/
                 *                       teleporting target to be solid+visible
                 *   injector          — note: poison/elixir delivered if charged
                 * Plus Phase 8 armor reactions on the DEFENDER:
                 *   silverContact / meteoriteContact — staggers a vulnerable
                 *     attacker who hits this armor with natural / brawling.
                 *   archeryShield / deployable — descriptive notes
                 *   criticalBlock — when the defender beat the attacker by
                 *     >4 on Block/Parry with a Manticore shield → free
                 *     Shield Strike rider note. */
                try {
                    const attkQ = new Set(weapon?.system?.effective?.qualities ?? weapon?.system?.qualities ?? []);
                    const onHit = delta > 0 && _defenderActor;
                    // Magically Anchoring
                    if (onHit && attkQ.has("magicalAnchoring")) {
                        const cleared = [];
                        for (const sid of ["intangible", "invisible", "teleporting"]) {
                            if (_defenderActor.statuses?.has?.(sid)) {
                                try { await emitApplyStatus({ targetUuid: _defenderActor.uuid, statusId: sid, action: "remove" }); }
                                catch (_) { /* best-effort */ }
                                cleared.push(sid);
                            }
                        }
                        const fragMA =
                            `<div class="wdm-attack-rider">` +
                                `<i class="fa-solid fa-anchor"></i> ` +
                                `<strong>Magically Anchoring</strong>: ` +
                                `<em>${esc(_defenderActor.name)}</em> is forced visible and solid` +
                                (cleared.length ? ` — cleared ${esc(cleared.join(", "))}` : "") + `.` +
                            `</div>`;
                        await appendAttackResult(result.message, {
                            fragment: fragMA,
                            summaryAdd: { label: "Anchored", kind: "status", icon: "fa-anchor" }
                        });
                    }
                    // Injector — descriptive (UI for charging the injector is
                    // out of scope; the note prompts the GM to fold in the
                    // poison/elixir's listed delivery).
                    if (onHit && attkQ.has("injector")) {
                        const fragInj =
                            `<div class="wdm-attack-rider">` +
                                `<i class="fa-solid fa-syringe"></i> ` +
                                `<strong>Injector</strong>: if charged, the poison is +3 harder to resist or the elixir lasts +3 rounds (EO p.7).` +
                            `</div>`;
                        await appendAttackResult(result.message, {
                            fragment: fragInj,
                            summaryAdd: { label: "Injector", kind: "info", icon: "fa-syringe" }
                        });
                    }
                    // Phase 8 — Silver / Meteorite Contact armor (EO p.8):
                    // a Silver- or Meteorite-vulnerable MONSTER who hits the
                    // armor with a natural attack OR a brawling exchange is
                    // staggered. Detect "natural attack" by attacker.type
                    // === "monster" with an unarmed-style weapon (Brawling
                    // skill key or skipDialog/weapon.system.weaponType ===
                    // "natural"); brawling exchange = punch/kick/grapple via
                    // the brawl mixin's strike API. We fire on a HIT only.
                    if (onHit && this.type === "monster") {
                        const wornDef = _defenderActor?.items?.filter?.(i =>
                            i.type === "armor" && i.system?.equipped) ?? [];
                        const dQs = (it) => it.system?.effective?.qualities ?? it.system?.qualities ?? [];
                        const susceptibleSilver = !!_defenderActor; // surface-only — engine has no per-monster susceptibility map
                        const susceptibleMeteor = !!_defenderActor;
                        const skKey = weapon?.system?.skillKey || "";
                        const isNaturalOrBrawl = skKey === "brawling" || weapon?.system?.weaponType === "natural";
                        let armorTriggered = "";
                        for (const a of wornDef) {
                            const qs = dQs(a);
                            if (qs.includes("silverContact") && susceptibleSilver && isNaturalOrBrawl) { armorTriggered = "Silver Contact"; break; }
                            if (qs.includes("meteoriteContact") && susceptibleMeteor && isNaturalOrBrawl) { armorTriggered = "Meteorite Contact"; break; }
                        }
                        if (armorTriggered) {
                            try { await emitApplyStatus({ targetUuid: this.uuid, statusId: "staggered", action: "apply" }); }
                            catch (_) { /* best-effort */ }
                            const fragSC =
                                `<div class="wdm-attack-rider">` +
                                    `<i class="fa-solid fa-shield-virus"></i> ` +
                                    `<strong>${esc(armorTriggered)}</strong>: ` +
                                    `<em>${esc(this.name)}</em> is staggered (EO p.8).` +
                                `</div>`;
                            await appendAttackResult(result.message, {
                                fragment: fragSC,
                                summaryAdd: { label: `${this.name}: Staggered`, kind: "status", icon: "fa-shield-virus" }
                            });
                        }
                    }
                    /* Phase 8 — Critical Block (Manticore shield, EO p.8 /
                     * Witcher Tools): on a Block/Parry that beats the attacker
                     * by more than 4 with the witcher Manticore shield, a free
                     * Shield Strike triggers. Detect via the defender's worn
                     * Manticore shield carrying `criticalBlock` and a parry/
                     * block defense that beat by > 4. */
                    if (defChoice?.itemId && (defChoice.action === "parry" || defChoice.action === "block") && delta < -4) {
                        const it = _defenderActor?.items?.get?.(defChoice.itemId);
                        const qs = it ? (it.system?.effective?.qualities ?? it.system?.qualities ?? []) : [];
                        if (qs.includes("criticalBlock")) {
                            const fragCB =
                                `<div class="wdm-attack-rider">` +
                                    `<i class="fa-solid fa-shield"></i> ` +
                                    `<strong>Critical Block</strong>: ` +
                                    `<em>${esc(_defenderActor.name)}</em> beats by ${Math.abs(delta)} ` +
                                    `— free Shield Strike knocks <em>${esc(this.name)}</em> back 4m and prone.` +
                                `</div>`;
                            await appendAttackResult(result.message, {
                                fragment: fragCB,
                                summaryAdd: { label: "Critical Block!", kind: "status", icon: "fa-shield" }
                            });
                        }
                    }
                    /* Phase 8 — Critical Riposte (witcher weapon, EO p.8 /
                     * Witcher Tools): when defender beats by >4 on a Parry
                     * with a weapon carrying `criticalRiposte`, surface a
                     * free-Strike rider note. */
                    if (defChoice?.itemId && defChoice.action === "parry" && delta < -4) {
                        const it = _defenderActor?.items?.get?.(defChoice.itemId);
                        const qs = it ? (it.system?.effective?.qualities ?? it.system?.qualities ?? []) : [];
                        if (qs.includes("criticalRiposte")) {
                            const fragCR =
                                `<div class="wdm-attack-rider">` +
                                    `<i class="fa-solid fa-bolt"></i> ` +
                                    `<strong>Critical Riposte</strong>: ` +
                                    `<em>${esc(_defenderActor.name)}</em> beats parry by ${Math.abs(delta)} — free Strike with a held weapon (no extra STA / no penalty).` +
                                `</div>`;
                            await appendAttackResult(result.message, {
                                fragment: fragCR,
                                summaryAdd: { label: "Critical Riposte!", kind: "status", icon: "fa-bolt" }
                            });
                        }
                    }
                    /* Phase 8 — Critical Flurry / Spellcasting / Momentum
                     * (EO p.8 / Witcher Tools). When the ATTACKER (this)
                     * scores a crit with a witcher weapon AND wears the
                     * matching armor, the listed action fires for free.
                     * We surface as a chat-card NOTE; the actual free
                     * action lives in the GM's hands (rolling a Disarm /
                     * Trip / Sign / extra Strike). */
                    if (sev && delta > 0) {
                        const wornAtk = (this.items ?? []).filter(i =>
                            i.type === "armor" && i.system?.equipped);
                        const aQs = (a) => a.system?.effective?.qualities ?? a.system?.qualities ?? [];
                        const hasFlurry      = wornAtk.some(a => aQs(a).includes("criticalFlurry"));
                        const hasSpellcast   = wornAtk.some(a => aQs(a).includes("criticalSpellcasting"));
                        const hasMomentum    = wornAtk.some(a => aQs(a).includes("criticalMomentum"));
                        if (hasFlurry) {
                            await appendAttackResult(result.message, {
                                fragment:
                                    `<div class="wdm-attack-rider">` +
                                        `<i class="fa-solid fa-wind"></i> ` +
                                        `<strong>Critical Flurry</strong>: ` +
                                        `<em>${esc(this.name)}</em>'s witcher armor grants a free Disarm or Trip at no penalty / STA.` +
                                    `</div>`,
                                summaryAdd: { label: "Critical Flurry", kind: "status", icon: "fa-wind" }
                            });
                        }
                        if (hasSpellcast) {
                            await appendAttackResult(result.message, {
                                fragment:
                                    `<div class="wdm-attack-rider">` +
                                        `<i class="fa-solid fa-wand-magic-sparkles"></i> ` +
                                        `<strong>Critical Spellcasting</strong>: ` +
                                        `<em>${esc(this.name)}</em>'s witcher armor grants a free Spellcasting check (Sign cost only).` +
                                    `</div>`,
                                summaryAdd: { label: "Critical Spellcasting", kind: "status", icon: "fa-wand-magic-sparkles" }
                            });
                        }
                        if (hasMomentum) {
                            await appendAttackResult(result.message, {
                                fragment:
                                    `<div class="wdm-attack-rider">` +
                                        `<i class="fa-solid fa-forward"></i> ` +
                                        `<strong>Critical Momentum</strong>: ` +
                                        `<em>${esc(this.name)}</em>'s witcher armor grants a single free Strike with a held weapon.` +
                                    `</div>`,
                                summaryAdd: { label: "Critical Momentum", kind: "status", icon: "fa-forward" }
                            });
                        }
                    }
                    /* Phase 8 — Set Bonus framework rider. When ALL of
                     * the attacker's worn armor pieces declare the same
                     * `setBonus` parameter (e.g. "Cat School"), surface
                     * a note on the card. No per-set bonus lookup. */
                    if (delta > 0) {
                        const wornAtk = (this.items ?? []).filter(i =>
                            i.type === "armor" && i.system?.equipped);
                        if (wornAtk.length >= 2) {
                            const setNames = new Set();
                            let allWithSet = true;
                            for (const a of wornAtk) {
                                const qs = a.system?.effective?.qualities ?? a.system?.qualities ?? [];
                                if (!qs.includes("setBonus")) { allWithSet = false; break; }
                                const v = (a.system?.effective?.qualityValues ?? a.system?.qualityValues ?? {}).setBonus;
                                if (v) setNames.add(String(v).trim());
                            }
                            if (allWithSet && setNames.size === 1) {
                                const name = [...setNames][0];
                                await appendAttackResult(result.message, {
                                    fragment:
                                        `<div class="wdm-attack-rider">` +
                                            `<i class="fa-solid fa-medal"></i> ` +
                                            `<strong>Set Bonus</strong>: ` +
                                            `<em>${esc(this.name)}</em> wears the full <em>${esc(name)}</em> set — apply its signature bonus.` +
                                        `</div>`,
                                    summaryAdd: { label: `Set: ${name}`, kind: "info", icon: "fa-medal" }
                                });
                            }
                        }
                    }
                } catch (err) {
                    console.warn("witcher-ttrpg-death-march | misc on-hit riders failed", err);
                }
            }

            // Firing the shot spends its round: a chambered weapon (crossbow)
            // empties, a bow draws the chosen round from its quiver. No-op for melee.
            if (usesAmmo) {
                try { await weapon.spendShot(shotAmmoId); }
                catch (err) { console.warn("witcher-ttrpg-death-march | spendShot failed", err); }
            }

            /* Reposition voids follow-up Fast-attack swings (Core p.156-157).
             *
             *   Fast attack: same weapon strikes twice in one action; the
             *   second swing depends on the defender still being in the
             *   weapon's threat zone. A defender who *successfully*
             *   Repositions out of the original square is no longer in
             *   reach, so the follow-up finds empty air.
             *
             *   Joint attack: two weapons strike *simultaneously* (RAW
             *   Core p.163), so a Reposition on the first defense doesn't
             *   change the second swing's outcome — both resolve as
             *   declared. We explicitly DON'T break for joint.
             *
             *   Long Reach (and any other quality flagged
             *   `ignoresRepositionDistance` in the GM's catalog) overrides
             *   this: the weapon's reach extends past the defender's
             *   escape distance, so both swings land normally.
             *
             * Trigger condition is "Reposition that BEAT the attack" —
             * a failed reposition means the attack landed on the original
             * square, so the second swing keeps swinging normally. */
            if (
                i < attacks - 1
                && decl.strike === "fast"
                && defChoice?.action === "reposition"
                && Number.isFinite(Number(defChoice?.defenseTotal))
                && Number(result?.total) <= Number(defChoice.defenseTotal)
                && !weaponIgnoresRepositionDistance(shotWeapon)
            ) {
                try {
                    await ChatMessage.create({
                        speaker,
                        content:
                            `<em><strong>${esc(_defenderActor?.name ?? "Defender")}</strong> ` +
                            `Repositions out of reach — <strong>${esc(this.name)}</strong>'s ` +
                            `follow-up Fast-attack swing finds empty air.</em>`,
                        flags: { [SYSTEM_ID]: { category: "combat" } }
                    });
                } catch (err) {
                    console.warn("witcher-ttrpg-death-march | reposition-void notice failed", err);
                }
                break;
            }
        }

        // Spend the committed adrenaline dice now (declared at roll time): drain
        // the pool and pay the configured STA per die (RAW 10, Core p.176). The
        // +Nd6 is already baked into the first shot's damage formula on the card.
        //
        // Witchers Reborn — Wolf · Calm Mind: adrenaline dice poured into
        // attack damage cost HALF STA (round down). Only fires for a real
        // strike (adrenaline dice already skip on feint / off-hand shot),
        // and only when the actor owns the perk.
        if (adrenalineDice > 0) {
            try {
                const staPer = hasWRPerk(this, "calmMind")
                    ? Math.floor(adrenalineStaPerDie() / 2)
                    : adrenalineStaPerDie();
                await this.update({ "system.adrenaline.value": Math.max(0, adrPool - adrenalineDice) });
                await this.spendStamina?.(adrenalineDice * staPer, { reason: "adrenaline" });
            } catch (err) {
                console.warn("witcher-ttrpg-death-march | adrenaline spend failed", err);
            }
        }

        // Aim is single-use: the bonus is folded into this shot, so clear the
        // Aim status now (ranged only). consumeAim no-ops when not aiming.
        if (firedRanged && aimBonus) {
            try { await this.consumeAim(); }
            catch (err) { console.warn("witcher-ttrpg-death-march | consumeAim failed", err); }
        }

        // Fast Draw is spent the moment its -3 is folded into an attack — clear
        // the status so it doesn't bleed into later rolls this turn.
        if (decl.fastDraw && this.statuses?.has?.("fastDraw")) {
            try { await this.toggleStatusEffect("fastDraw", { active: false }); }
            catch (err) { console.warn("witcher-ttrpg-death-march | failed to clear fastDraw", err); }
        }

        /* Phase 4 — Nimble STA refund (EO p.7). The round-mixin canonically
         * spent 3 STA for the extra-action and/or fast-draw; refund the
         * Nimble reduction here so the wallet ends up paying (3 − reduction)
         * each. Skipped when not in combat or when no extra action fired. */
        if (nimbleStaRefund > 0) {
            try {
                const sta = this.system?.derivedStats?.sta;
                if (sta) {
                    const next = Math.min((Number(sta.value) || 0) + nimbleStaRefund, Number(sta.max) || 0);
                    await this.update({ "system.derivedStats.sta.value": next });
                }
            } catch (err) {
                console.warn("witcher-ttrpg-death-march | nimble STA refund failed", err);
            }
        }

        // Any throw leaves the hand — the weapon lands at the target. Drop
        // it to the world (pick-up-able) and remove it from the actor. Under
        // the new CE model every one-handed weapon with a range can be
        // thrown, so the drop signal is the throw STRIKE itself, not the
        // weapon's declared type. Weapons never stack — one item, one throw.
        const out = { ...result, formula, weapon, damage: damageStr, location: loc, declaration: decl };
        if (decl?.strikeMeta?.thrown) {
            try { await this._dropThrownWeapon(weapon); }
            catch (err) { console.warn("witcher-ttrpg-death-march | thrown-weapon drop failed", err); }
        }
        return out;
    }

    /** Drop a thrown weapon into the world after it's been thrown: it leaves
     *  the actor's hand entirely. Sequence (order matters):
     *
     *    1. Unequip the actor's copy — belt-and-suspenders in case the
     *       delete below fails partway. The visual dock slot clears
     *       immediately so the actor's hand reads empty even before the
     *       item document goes away.
     *    2. Clone the item data into the world Items collection so it can
     *       be picked up (Foundry v13's owner-none ownership excludes
     *       everyone; OWNER default keeps it usable).
     *    3. Detach from any container that held it (keeps container
     *       manifests honest — a stale uuid in a pouch confuses the sheet).
     *    4. Delete the actor's embedded copy.
     *
     *  Best-effort throughout — every step is wrapped so a single failure
     *  doesn't strand the weapon in a half-thrown state. */
    async _dropThrownWeapon(weapon) {
        /* 1. Unequip on the actor side FIRST — so even if the world
         * clone or the delete fails, the actor no longer counts the
         * weapon as in-hand. Also clears any slot-assignment flags
         * the sheet uses (main / off / quick / two-hand). */
        try {
            const wu = { "system.equipped": false };
            if (weapon.system?.slot !== undefined) wu["system.slot"] = "";
            if (weapon.system?.twoHandMode !== undefined) wu["system.twoHandMode"] = false;
            await weapon.update(wu);
        } catch (err) {
            console.warn("witcher-ttrpg-death-march | thrown-weapon unequip failed", err);
        }

        /* 2. Clone into the world Items directory. The cloned item is
         * owner-accessible (default: OWNER) so any player can pick it
         * up via drag-into-inventory later. */
        const OWNER = (globalThis.CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OWNER) ?? 3;
        const data = weapon.toObject(false);
        data.ownership = { default: OWNER };
        /* World items don't need the equipped / slot state — they were
         * set true here only because they were mid-transition on the
         * actor. Strip them so a picked-up copy starts unequipped. */
        if (data.system) {
            data.system.equipped = false;
            if (data.system.slot !== undefined) data.system.slot = "";
            if (data.system.twoHandMode !== undefined) data.system.twoHandMode = false;
        }
        try {
            await Item.implementation.create(data);
        } catch (err) {
            console.warn("witcher-ttrpg-death-march | thrown-weapon world create failed", err);
            /* Even without the world clone, still delete the embedded
             * copy — the user's expectation is "it left my hand". */
        }

        /* 3. Remove from any container's content list. */
        for (const c of this.items) {
            if (c.type !== "container") continue;
            const content = c.system?.content ?? [];
            if (content.includes(weapon.uuid) || content.includes(weapon.id)) {
                try {
                    await c.update({ "system.content": content.filter(u => u !== weapon.uuid && u !== weapon.id) });
                } catch (err) {
                    console.warn("witcher-ttrpg-death-march | thrown-weapon container detach failed", err);
                }
            }
        }

        /* 4. Delete the actor's copy — it's no longer in-hand. */
        try {
            await weapon.delete();
        } catch (err) {
            console.warn("witcher-ttrpg-death-march | thrown-weapon delete failed", err);
        }

        ui?.notifications?.info?.(`${this.name} throws ${weapon.name} — it lands in the world.`);
    }
};
