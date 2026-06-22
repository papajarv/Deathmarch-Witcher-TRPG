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
import { STRIKE_TYPES, ATTACK_LOCATIONS, rollHitLocation, EXTRA_ACTION,
         getActiveWeaponQualities, WEAPON_QUALITIES, shieldBashDamage }
    from "../../setup/config.mjs";
import { isAdrenalineEnabled, adrenalineStaPerDie } from "../../api/adrenaline.mjs";
import { attackMod as statusAttackMod, clauseFor as _clauseFor, cannotDefend } from "../../mechanics/statusEngine.mjs";
import { emitApplyDamage, emitApplyStatus, emitReduceReliability, requestDefenseFromOwner } from "../../setup/socketHook.mjs";
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

function attackRollFlavor({ actorName, weaponName, subtitle, chips = [], damage, qualities = [], qualityKeys = [], qualityValues = {}, note = "", hitLocation = null }) {
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

    const damageHtml = damage?.display ? `
        <div class="wdm-attack-damage">
            <span class="wdm-attack-damage-k">${esc(game.i18n.localize("WITCHER.Attack.Damage"))}</span>
            <span class="wdm-attack-damage-v">${esc(damage.display)}</span>
            ${damage.formula ? `<button type="button" class="wdm-attack-damage-roll" data-action="wdm-roll-damage" data-formula="${esc(damage.formula)}" data-types="${esc(damage.types ?? "")}" data-loc-mult="${esc(locMult)}" data-loc-label="${esc(damage.locLabel ?? "")}"${locKeyAttr}${qualAttr}><i class="fa-solid fa-burst"></i> ${esc(game.i18n.localize("WITCHER.Attack.RollDamage"))}</button>` : ""}
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
            const pct = Math.max(0, Math.min(100, Number(qualityValues?.[key]) || 0));
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
        const head = game.i18n.localize("WITCHER.Attack.Damage");
        const note = locMult !== 1
            ? `<div class="wdm-attack-damage-note">${esc(game.i18n.localize("WITCHER.Attack.SubtractSP"))} ×${esc(locMult)}${locLabel ? ` (${esc(locLabel)})` : ""}</div>`
            : "";

        /* Single-card consolidation: instead of posting a separate damage
         * card here, build the rolled-dice HTML and APPEND it to the attack
         * card. The breakdown + crit wound info that follow also append to
         * the same card (via attackMessageUuid in their payloads) so the
         * whole resolution lives in one place. */
        const diceHtml = await roll.render();
        const damageBlockHtml =
            `<div class="wdm-attack-damage-roll-block">` +
                `<div class="wdm-attack-damage-roll-head">${esc(head)}${types ? ` <span class="wdm-attack-damage-roll-types">— ${esc(types)}</span>` : ""}</div>` +
                note +
                diceHtml +
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
        let targets = Array.from(game.user?.targets ?? [])
            .map(t => t?.actor)
            .filter(a => !!a);
        if (!targets.length) {
            try {
                const tokenlessTarget = await getActorTarget();
                if (tokenlessTarget) targets = [tokenlessTarget];
            } catch (_) { /* no actor-target flag set */ }
        }
        const isDamaging = Number.isFinite(roll.total) && roll.total > 0;
        if (targets.length && isDamaging) {
            const { keys: qualityKeys, values: qualityValues } = readQualityPayload(btn);
            const locKey = btn.dataset.locKey || "";
            for (const actor of targets) {
                try {
                    // AWAIT so the breakdown + rider applies finish before
                    // we move to the next target (and so the audit can read
                    // the resulting actor state without racing).
                    await emitApplyDamage({
                        targetUuid:        actor.uuid,
                        weaponDamage:      roll.total,
                        damageTypes:       types ? types.toLowerCase().split(/[\s·,/]+/).filter(Boolean) : [],
                        locationKey:       locKey,
                        locationLabel:     locLabel,
                        qualities:         qualityKeys,
                        qualityValues,
                        critSeverity,
                        attackMessageUuid: msg?.uuid ?? null
                    });
                } catch (err) {
                    console.warn(`witcher-ttrpg-death-march | apply damage to ${actor.name} failed`, err);
                }
                /* Riders moved into handleApplyDamage so they fire once per
                 * damage event regardless of trigger source (damage button
                 * here, GM dock auto-apply, future scripted damage). */
            }
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
    });
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
     * stamina/extra-action surcharge). */
    const strikeKey  = overrides.strike && STRIKE_TYPES[overrides.strike] ? overrides.strike : "normal";
    const strikeMeta = STRIKE_TYPES[strikeKey];
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
        if (!options.skipDialog && !game.user?.targets?.size) {
            const DialogV2 = foundry?.applications?.api?.DialogV2;
            if (DialogV2) {
                let go = false;
                try {
                    go = await DialogV2.confirm({
                        window: { title: `Attack without a target?` },
                        content:
                            `<p>You haven't targeted anyone. Roll an attack with <strong>${esc(weapon.name)}</strong> anyway?</p>` +
                            `<p style="opacity:0.7;font-size:11px;">Tip: click an enemy token to target it (T-key on a hovered token).</p>`,
                        rejectClose: false
                    });
                } catch (_) { go = false; }
                if (!go) return null;
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
            const wSkillKey = skillKeyOverride || w.system?.skillKey || "";
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

        // Dual-mode thrown weapon (carries a meleeSkillKey): the card lets the
        // player throw it or strike in hand. Build the melee-mode profile too so
        // the dialog can show its base and the shot can roll the right skill.
        const dualMode  = weapon.system?.weaponType === "thrown" && !!weapon.system?.meleeSkillKey;
        const meleeProf = dualMode ? readWeaponProfile(weapon, weapon.system.meleeSkillKey) : null;
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
            decl = await openAttackDialog(weapon, this, { base: { total: baseTotal, chips: baseChips }, meleeBase });
            if (!decl) return null;   // player cancelled
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
         * and engagement-linked verdict patching). */
        let _defenderActor = _firstTarget?.actor;
        if (!_defenderActor) {
            try { _defenderActor = await getActorTarget(); }
            catch (_) { _defenderActor = null; }
        }
        const _willPrompt = _defenderActor
            && _defenderActor !== this
            && !options.dc && !decl.targetDC
            /* Feint doesn't call for an opposed defense — it's the attacker's
             * Deceit check (firstRollSkill = "deceit") that sets up the +3
             * for the NEXT attack. The defender's Awareness is read passively
             * (no parry/block/dodge prompt). Skip the prompt entirely. */
            && decl.strike !== "feint";
        /* Items the defender already committed to a previous shot in THIS
         * declaration — passed to subsequent prompts so a joint-attack's
         * second prompt can disallow the parry item used in the first
         * (RAW Core p.163: "must have two weapons (or a weapon and a
         * shield) if they want to block or parry both attacks"). Fast
         * strikes don't enforce this — the same item parries both at the
         * cost of 1 STA per extra defense. */
        const _usedDefenseItemIds = [];

        // Which mode the attack resolved in. A dual-mode weapon thrown in melee
        // mode rolls the melee profile, isn't a ranged shot (no aim consume), and
        // stays in hand (no thrown-drop). skipDialog has no mode → defaults thrown.
        const useMelee   = dualMode && decl.mode === "melee";
        const activeProf = useMelee ? meleeProf : mainProf;
        const firedRanged = useMelee ? false : isRanged;

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
        const damageFor = (w, adr = 0) => {
            const d = w.type === "shield"
                ? shieldBashDamage(this, w)
                : (w.system?.effective?.damage || w.system?.damage || "");
            if (noDamage || !d) return { display: "", formula: "" };
            let display = strikeMult !== 1 ? `${d} ×${strikeMult}` : d;
            let formula = strikeMult !== 1 ? `(${d})*${strikeMult}` : d;
            if (adr > 0) { display += ` + ${adr}d6`; formula += ` + ${adr}d6`; }
            return { display, formula };
        };
        const mainDamage = damageFor(weapon, adrenalineDice);
        const damageStr  = mainDamage.display;

        // Status penalties to the attack (Staggered −2, Blinded −3, Prone −2,
        // Exhausted −1, …) folded straight onto the to-hit. Summed live from the
        // actor's active conditions by the status engine.
        const statusAtk = statusAttackMod(this);

        // To-hit total. decl.modTotal already folds strike/aim/location/range/
        // situational/weather/other; add the base skill/WA and any flat caller
        // modifier on top.
        const grandMod = activeProf.baseTotal + decl.modTotal + flatMod + statusAtk + (Number(cm.flatAttackMod) || 0);
        const formula  = grandMod ? `1d10 + ${grandMod}` : `1d10`;

        const localizeTypes = (keys) => (keys ?? [])
            .filter(t => typeof t === "string" && t.length > 0)
            .map(t => game.i18n.localize(CONFIG.WITCHER.damageTypes?.[t] ?? t))
            .filter(Boolean);

        // Location chip (shows the rolled face for random shots; omitted for
        // inanimate shots, which have no hit location).
        const locLabel = loc.mode === "random" ? `${loc.label} (d10: ${loc.face})` : loc.label;

        const attacks = Math.max(1, decl.strikeMeta?.attacks ?? 1);
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
        let result = null;

        // Adrenaline dice ride the first (and, for a feint, only) shot.
        const damagingShot = 0;

        for (let i = 0; i < attacks; i++) {
            // Feint: the one and only shot is a Deceit roll — no weapon strike, no
            // damage, no location. Everything else rolls the weapon.
            const isFeintRoll = !!feintProfile && i === 0;
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
                    decl._defenseChoice = await requestDefenseFromOwner({
                        defenderActor:     _defenderActor,
                        attackerName:      this.name,
                        weaponName:        shotWeapon.name,
                        weaponImg:         shotWeapon.img,
                        engagementId:      _shotEngagementId,
                        attackKind:        decl.strike,
                        shotIndex:         i + 1,
                        totalShots:        attacks,
                        disallowedItemIds
                    });
                    if (decl._defenseChoice?.itemId) _usedDefenseItemIds.push(decl._defenseChoice.itemId);
                } catch (err) {
                    console.warn("witcher-ttrpg-death-march | defense prompt failed", err);
                    decl._defenseChoice = { action: "none" };
                }
            }

            const prof  = isFeintRoll ? feintProfile
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
            const typeKeys = usesAmmo
                ? [...new Set([...wTypeKeys, ...(shotAmmo?.system?.damageTypes ?? [])])]
                : wTypeKeys;
            const types = isFeintRoll ? [] : localizeTypes(typeKeys);
            const shotSkillName = prof.skillKey
                ? game.i18n.localize(CONFIG.WITCHER.skillLabel(prof.skillKey))
                : game.i18n.localize("WITCHER.attack.noSkill");
            const subtitle = [shotSkillName, types.join(" · ")].filter(Boolean).join(" · ");
            const qualities = isFeintRoll ? [] : (usesAmmo ? shotQualityLabels(shotWeapon, shotAmmo) : shotQualityLabels(shotWeapon, null));
            /* Raw quality KEYS / values for the post-hit rider logic. A feint
             * doesn't strike, so no riders fire. */
            const riderPayload = isFeintRoll
                ? { keys: [], values: {} }
                : (usesAmmo ? shotQualityRiders(shotWeapon, shotAmmo) : shotQualityRiders(shotWeapon, null));

            // Adrenaline dice land on the damaging shot only (one declaration per
            // attack), so a Fast strike's 2nd shot / a joint off-hand / a feint's
            // Deceit roll don't double-count them.
            const shotDamage   = isFeintRoll ? { display: "", formula: "" } : damageFor(shotWeapon, i === damagingShot ? adrenalineDice : 0);
            /* Feint advantage: a successful prior Feint stamps the
             * attacker with `flags.{sys}.feintAdvantage`. The NEXT attack
             * (this one, if not itself a feint) consumes the flag and
             * adds +3 to the to-hit, per RAW Core p.163. */
            const feintAdv = (!isFeintRoll && i === 0)
                ? !!this.getFlag(SYSTEM_ID, "feintAdvantage")
                : false;
            const feintBonus = feintAdv ? 3 : 0;
            // Feint's Deceit roll drops the called-shot penalty (it isn't aimed).
            const shotGrandMod = prof.baseTotal + decl.modTotal + flatMod + statusAtk
                               - (isFeintRoll ? locPenalty : 0)
                               + feintBonus;
            const shotFormula  = shotGrandMod ? `1d10 + ${shotGrandMod}` : `1d10`;

            /* Status breakdown chips — surface attacker AND target statuses
             * that affect the math. Math is correct already (attacker's
             * statusAtk folded into shotGrandMod above; target's status-def
             * is folded into THEIR defense roll on their card). These chips
             * are INFORMATIONAL on the attack card so the table can see at
             * a glance what's stacking. RAW p.155-156 modifiers. */
            const attackerStatusChips = breakdownStatusMods(this, "attack");
            const targetStatusChips   = _defenderActor && _defenderActor !== this
                ? breakdownStatusMods(_defenderActor, "defense").map(c => ({ ...c, label: `Target ${c.label}` }))
                : [];
            const shotChips = [
                ...baseChipsFor(prof),
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
            const weaponName = isFeintRoll
                ? game.i18n.localize("WITCHER.Attack.StrikeFeint")
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
            const composedNote = [strikeNote, defenseLine].filter(Boolean).join(" — ");
            const flavor = attackRollFlavor({
                actorName: this.name,
                weaponName,
                subtitle,
                hitLocation: hitLocationInfo,
                chips: shotChips,
                qualities,
                qualityKeys:   riderPayload.keys,
                qualityValues: riderPayload.values,
                note: composedNote,
                damage: { display: shotDamage.display, formula: shotDamage.formula, types: types.join(" · "), locMult, locLabel: loc.label, locKey: loc.key }
            });
            result = await extendedRoll(
                shotFormula,
                {
                    speaker, flavor,
                    /* Stamp the attack total + engagement id + chat
                     * category on this chat message so:
                     *   - the damage button (same message) can read totals
                     *   - matching defense card can be looked up
                     *   - chat filter routes it to Combat Logs */
                    flags: (r) => ({
                        [SYSTEM_ID]: {
                            category: "combat",
                            ...(decl._engagementId
                                ? { engagementId: decl._engagementId, attackTotal: r.total }
                                : {})
                        }
                    })
                },
                dc != null ? { threshold: dc } : {}
            );

            /* Feint flag housekeeping — set after this shot if it WAS a
             * feint (the next attack will consume it for +3); clear if this
             * shot CONSUMED a prior feint advantage. */
            try {
                if (isFeintRoll) {
                    await this.setFlag(SYSTEM_ID, "feintAdvantage", true);
                    await ChatMessage.create({
                        speaker,
                        content: `<em><strong>${esc(this.name)}</strong> feints — next attack at <strong>+3</strong>.</em>`,
                        flags: { [SYSTEM_ID]: { category: "combat" } }
                    });
                } else if (feintAdv) {
                    await this.unsetFlag(SYSTEM_ID, "feintAdvantage");
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
                const defenseLabel = hasDefense
                    ? ((isStunnedHit || isDc10Pass)
                        ? `<div class="wdm-attack-defense"><span class="wdm-attack-defense-k">Defense</span> <span class="wdm-attack-defense-v"><b>${isStunnedHit ? "Stunned" : (defChoice?.timedOut ? "No response" : "Took the hit")}</b> — DC <b>10</b></span></div>`
                        : `<div class="wdm-attack-defense"><span class="wdm-attack-defense-k">Defense</span> <span class="wdm-attack-defense-v"><b>${esc(defActionTitle)}</b> → <b>${defenseTotal}</b></span>${defChoice?.defenseBody ? `<div class="wdm-attack-defense-body">${defChoice.defenseBody}</div>` : ""}</div>`)
                    : "";
                const verdictClass = delta > 0
                    ? (sev ? `is-hit is-crit is-crit-${sev}` : "is-hit")
                    : "is-miss";
                const verdictHead = delta > 0
                    ? (sev ? `HIT — ${sev.toUpperCase()} CRIT` : "HIT")
                    : "MISS";
                const verdictSub  = delta > 0
                    ? `attacker beat by ${delta}`
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
                try {
                    const cur = String(result.message.content ?? "");
                    let next = cur;
                    if (delta > 0) {
                        // Hit: insert defense + verdict ABOVE the damage button
                        // block so the GM sees the comparison before clicking.
                        next = cur.includes("wdm-attack-damage")
                            ? cur.replace(/<div class="wdm-attack-damage">/, `${verdictHtml}<div class="wdm-attack-damage">`)
                            : `${cur}${verdictHtml}`;
                    } else {
                        // Miss: strip the damage block entirely, keep defense+verdict.
                        next = cur.replace(/<div class="wdm-attack-damage">[\s\S]*?<\/div>(<div class="wdm-attack-damage-note">[\s\S]*?<\/div>)?/, verdictHtml);
                        if (next === cur) next = `${cur}${verdictHtml}`;
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
                 * consequence sits with everything else. */
                if (defChoice?.action === "parry" && delta < 0) {
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

                /* Block auto-reliability spend: a Block that BEAT the
                 * attack ate the hit on the weapon/shield — spend 1
                 * point of its Reliability automatically. The reliability
                 * write (+ break notice) is GM-side via socket; we
                 * also drop a folded line into the attack card here so
                 * the attacker / table sees the cost on the same card. */
                if (defChoice?.action === "block" && delta < 0 && defChoice?.itemId) {
                    try {
                        const blockItem = _defenderActor?.items?.get?.(defChoice.itemId);
                        if (blockItem?.uuid) {
                            await emitReduceReliability({
                                itemUuid: blockItem.uuid,
                                attackMessageUuid: result.message?.uuid ?? null
                            });
                        }
                    } catch (err) {
                        console.warn("witcher-ttrpg-death-march | block auto-reliability spend failed", err);
                    }
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
        if (adrenalineDice > 0) {
            try {
                await this.update({ "system.adrenaline.value": Math.max(0, adrPool - adrenalineDice) });
                await this.spendStamina?.(adrenalineDice * adrenalineStaPerDie(), { reason: "adrenaline" });
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

        // A thrown weapon leaves the hand — it lands at the target. Drop it to
        // the world (pick-up-able) and remove it from the actor. Weapons never
        // stack, so there's no quantity to decrement: one item, one throw.
        const out = { ...result, formula, weapon, damage: damageStr, location: loc, declaration: decl };
        if (!useMelee && weapon.system?.weaponType === "thrown") {
            try { await this._dropThrownWeapon(weapon); }
            catch (err) { console.warn("witcher-ttrpg-death-march | thrown-weapon drop failed", err); }
        }
        return out;
    }

    /** Drop a thrown weapon into the world after it's been thrown: clone it as
     *  an owner-accessible world item, unlink it from any container, then
     *  delete the actor's copy. Mirrors the dock's dropWeaponToWorld, kept here
     *  so the throw is consistent whether fired from the dock or the sheet. */
    async _dropThrownWeapon(weapon) {
        const OWNER = (globalThis.CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OWNER) ?? 3;
        const data = weapon.toObject(false);
        data.ownership = { default: OWNER };
        try {
            await Item.implementation.create(data);
        } catch (err) {
            console.warn("witcher-ttrpg-death-march | thrown-weapon world create failed", err);
            return;
        }
        for (const c of this.items) {
            if (c.type !== "container") continue;
            const content = c.system?.content ?? [];
            if (content.includes(weapon.uuid) || content.includes(weapon.id)) {
                await c.update({ "system.content": content.filter(u => u !== weapon.uuid && u !== weapon.id) });
            }
        }
        await weapon.delete();
        ui?.notifications?.info?.(`${this.name} throws ${weapon.name}.`);
    }
};
