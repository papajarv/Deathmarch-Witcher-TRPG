/**
 * bombs — throw dispatcher for weapon subtype "bomb".
 *
 * Launched from the same paths as any other weapon (combat dock click,
 * actor-sheet weapon card). `weaponAttackMixin.weaponAttack` detects
 * `weaponType === "bomb"` and delegates to `throwBomb(actor, item)`
 * instead of running the normal strike pipeline.
 *
 * Two flow variants:
 *
 * ── Canvas flow (caster has an active token on the scene) ────────────
 *   1. Present a FREE-anchor template shaped by `bombTemplate.shape` +
 *      sized by `bombTemplate.size` (circle uses shared `radius`).
 *      A translucent range ring is drawn around the caster showing
 *      max throw distance (parsed from the weapon's `range` field,
 *      e.g. `"BODYx3"`). Free-placed origin is clamped to the ring:
 *      cursor beyond max range snaps to the boundary (grid-aware, so
 *      it works on square, hex, and gridless).
 *   2. Left-click commits the landing hex. Right-click / Esc cancels
 *      the whole throw (no consume, no roll — the bomb stays in the
 *      bag).
 *   3. Roll Athletics (or `skillKey` override). Off-hand penalty
 *      (-3) applies when the bomb is wielded from the left / quick
 *      slot — same rule as any other weapon.
 *   4. On fumble, roll scatter (1d8 direction × 1d6 metres) and
 *      offset the ALREADY-placed origin. The AoE resolves at the
 *      scattered hex; the verdict card reports the scatter for GM
 *      audit. No re-placement — the throw already left the hand.
 *   5. Fan out defense prompts to each victim's owner in parallel.
 *      `allowedDefenses` is filtered by the bomb's `bombDefenses`
 *      (Block and/or Reposition — dodge/parry never apply to AoEs).
 *      `requiresShieldCover: true` gates block on RAW Full Cover /
 *      CE CV ≥ 6.
 *   6. Roll damage ONCE; each victim's own SP/DR filters it in
 *      emitApplyDamage.
 *   7. Opposed check per victim: defenseTotal ≥ throwTotal =
 *      avoided (ties favor defender). Failed / no-defense victims
 *      take the hit and receive cloned rider AEs, plus each rider's
 *      optional application damage as a separate hit.
 *   8. Decrement stack by 1 if `consumeOnThrow`. Append verdict
 *      fragment to the roll card.
 *
 * ── Fallback flow (no active canvas token / theatre-of-mind) ─────────
 *   Same as above, minus the template + range ring. Victims come from
 *   `game.user.targets` (canvas-selected tokens) if any, else from
 *   `getActorTargets()` (combat-tracker-assigned actor uuids). No
 *   scatter geometry (nothing to offset). Reposition still offered
 *   in the defense prompt for narrative flavor even though there's no
 *   AoE geometry to leave — defender's opposed roll still resolves it.
 */

import { extendedRoll }                                     from "../rolls/extendedRoll.mjs";
import { buildAreaTemplateClass, harvestTokens, AREA_CANCELLED, buildTemplateRegionData } from "./castArea.mjs";
import { isOffhandWeapon }                                  from "../applications/attackDialog.mjs";
import { durableAblationNegated }                           from "./durable.mjs";
import { getActorTargets }                                  from "../chrome/chrome/context-menu-actor.js";
import { applyQualityRiders }                               from "../documents/mixins/weaponAttackMixin.mjs";
import { getActiveWeaponQualities, WEAPON_QUALITIES }       from "../setup/config.mjs";
import { decrementArmorSP }                                 from "../chrome/chrome/dock.js";
import { requestDefenseFromOwner,
         emitApplyDamage,
         emitApplyStatus,
         emitApplyAuthoredEffects,
         emitAppendAttackFragment }                         from "../setup/socketHook.mjs";
import { t, tFormat }                                       from "../chrome/lib/i18n.js";
import { hrOffhandPenalty }                                 from "./house-rules-config.mjs";

const MODULE = "witcher-ttrpg-death-march";
/* Kept for backwards compat / documentation of the RAW default; the
 * live value used in bomb-throw math comes from `hrOffhandPenalty()`
 * so House Rules edits land here too. */
const OFFHAND_PENALTY = -3;

/* Bomb subtype's shape enum → Foundry MeasuredTemplate.t. Kept local
 * so the bomb schema (circle/cone/line/rect) doesn't need to match the
 * spell schema (cone/radius/cube/line) verbatim. */
const BOMB_SHAPE_TO_FOUNDRY = Object.freeze({
    circle: "circle",
    cone:   "cone",
    line:   "ray",
    rect:   "rect"
});

/** Resolve the bomb's template geometry. Circle reads the shared
 *  `radius` field; the other three read `bombTemplate.size`. Returns
 *  `{ shape, size, foundryType }` or null when unusable. */
export function resolveBombArea(item) {
    const shape = String(item?.system?.bombTemplate?.shape ?? "circle");
    const size  = shape === "circle"
        ? (Number(item?.system?.radius) || 0)
        : (Number(item?.system?.bombTemplate?.size) || 0);
    const foundryType = BOMB_SHAPE_TO_FOUNDRY[shape];
    if (!foundryType || size <= 0) return null;
    return { shape, size, foundryType };
}

/** Parse the bomb's `range` field into a metres number. Supports the
 *  same forms `attackDialog.resolveWeaponRange` does — plain numbers
 *  ("30", "30m") and stat expressions ("BODYx3", "REF*2"). Returns
 *  null when unparseable (caller treats as "no range constraint"). */
async function resolveBombRangeMetres(item, actor) {
    let raw = String(item?.system?.range ?? "").trim();
    if (!raw) return null;
    raw = raw.replace(/\s*(?:m|meters?|metres?)\s*$/i, "").trim();
    if (!raw) return null;
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
    /* Read the PREPARED stats so death-state ×1/3 applies (RAW p.156).
     * Wound state doesn't touch BODY per RAW (only REF/DEX/INT/WILL);
     * if something else on the actor is shifting BODY unexpectedly,
     * that's an AE-cleanup bug elsewhere — not something we should
     * paper over here by reading source. Force a fresh re-derive so
     * any pending AE toggles are folded in before we read. */
    try { actor?.reset?.(); } catch (_) { /* soft-fail */ }
    const stats = actor?.system?.stats ?? {};
    const expr = raw
        .replace(/[x×·]/gi, "*")
        .replace(/[a-z]+/gi, (tok) => {
            const v = stats[tok.toLowerCase()]?.value;
            return v != null ? String(v) : tok;
        });
    if (!/^[\d+\-*/().\s]+$/.test(expr)) return null;
    try {
        const r = await new Roll(expr).evaluate();
        return Number.isFinite(r.total) ? Number(r.total) : null;
    } catch (_) { return null; }
}

/** Convert scene metres → canvas pixels via the scene's grid metadata.
 *  Grid-agnostic (works for square, hex, gridless). */
function metresToPixels(metres) {
    if (!Number.isFinite(metres) || metres <= 0) return 0;
    const gridSize     = Number(canvas?.dimensions?.size) || 100;
    const gridDistance = Number(canvas?.dimensions?.distance) || 1;
    return metres * gridSize / gridDistance;
}

/** Roll a compass scatter: 1d8 direction (N/NE/E/…/NW at 45° steps) and
 *  1d6 metres distance. Returns { angleDeg, distanceMeters }. */
async function rollScatter() {
    const dirRoll  = await new Roll("1d8").evaluate();
    const distRoll = await new Roll("1d6").evaluate();
    const angleDeg = (Number(dirRoll.total) - 1) * 45;   /* 0°=N, 45°=NE, ... */
    return { angleDeg, distanceMeters: Number(distRoll.total), dirRoll, distRoll };
}

/** Convert pixels → scene metres via the current scene's grid metadata. */
function pixelsToMetres(px) {
    const gridSize     = Number(canvas?.dimensions?.size) || 100;
    const gridDistance = Number(canvas?.dimensions?.distance) || 1;
    return px * gridDistance / gridSize;
}

/** RAW range-band modifier table (Core p.152). Given the distance
 *  from the thrower to the landing hex and the bomb's max throw
 *  range, return the Athletics-roll modifier for THIS throw. Close
 *  favours the attacker (surprise); Long punishes the attacker
 *  (defenders see it coming, have more reaction time), which then
 *  makes each defender's opposed roll easier to beat.
 *
 *    Point Blank (≤0.5m absolute)      → +5
 *    Close       (0.5m — ¼ maxRange)   → 0
 *    Medium      (¼ — ½ maxRange)      → −2
 *    Long        (½ — full maxRange)   → −5
 *    Extreme     (> full maxRange)     → −6  (bombs can throw to 2×
 *                                             listed range — the clamp
 *                                             extends to the extreme
 *                                             boundary and the penalty
 *                                             makes it costly)
 *
 *  Returns { mod, band }: mod is the numeric penalty/bonus, band is
 *  the label used on the chat card. */
function rangeBandFor(distM, maxRangeM) {
    if (!Number.isFinite(distM) || distM <= 0) return { mod: 5,  band: "pointBlank" };
    if (distM <= 0.5)                          return { mod: 5,  band: "pointBlank" };
    const maxR = Number.isFinite(maxRangeM) && maxRangeM > 0 ? maxRangeM : 30;
    if (distM <= maxR * 0.25) return { mod:  0, band: "close" };
    if (distM <= maxR * 0.5)  return { mod: -2, band: "medium" };
    if (distM <= maxR)        return { mod: -4, band: "long" };
    return                          { mod: -6, band: "extreme" };
}

/** Compass angle + metres → screen pixel offset. North = up (-y). */
function scatterOffsetPixels(distanceMeters, angleDeg) {
    if (!canvas?.grid) return { dx: 0, dy: 0 };
    const pxPerMeter = metresToPixels(1);
    const rad = (angleDeg * Math.PI) / 180;
    return {
        dx:  Math.sin(rad) * distanceMeters * pxPerMeter,
        dy: -Math.cos(rad) * distanceMeters * pxPerMeter
    };
}

/** Present a range-clamped free-anchor template preview. Returns
 *  `{ captured, casterTokenId }` on commit, or null on cancel /
 *  canvas-unavailable. `captured` is the raw snapshot from
 *  `WitcherAreaTemplate.place` — carries the PIXI shape + origin +
 *  elevation so the caller can re-harvest tokens after scatter. */
async function pickBombLanding(actor, item, { maxRangePx = null, extremeRangePx = null } = {}) {
    if (!canvas?.scene || !canvas?.ready) return null;
    const area = resolveBombArea(item);
    if (!area) return null;

    const casterToken = actor.getActiveTokens?.()?.[0] ?? null;
    if (!casterToken) return null;
    const origin = { x: casterToken.center.x, y: casterToken.center.y };

    const templateData = {
        t: area.foundryType,
        user: game.user?.id ?? null,
        /* Cone slant scaling matches castArea (see the extended comment
         * there): `distance` on a 90° cone is the ray length, so we
         * multiply by √2 so the endpoint at ±45° lands at (size, ±size). */
        distance: area.foundryType === "cone" ? area.size * Math.SQRT2 : area.size,
        direction: 0,
        x: origin.x,
        y: origin.y,
        fillColor: game.user?.color ?? "#c8a878",
        flags: { [MODULE]: { bomb: true, sourceItem: item.uuid } }
    };
    if (area.foundryType === "cone") templateData.angle = 90;
    if (area.foundryType === "ray")  templateData.width = 1;

    const AreaTemplateClass = buildAreaTemplateClass();
    const captured = await AreaTemplateClass.place({
        templateData,
        itemName: item.name,
        anchor: "free",             /* bombs land at a target hex, not on the thrower */
        casterCenter: origin,
        casterToken,
        maxRangePx,
        extremeRangePx,
        showRangeRing: !!(maxRangePx || extremeRangePx)
    });
    /* Cancel (right-click / Esc) or setup-fail → don't throw the bomb. The
     * sentinel is truthy, so check it explicitly alongside the falsy case. */
    if (captured === AREA_CANCELLED || !captured) return null;
    return { captured, casterTokenId: casterToken?.id ?? "" };
}

/** Which defenses this bomb allows, based on the schema toggles.
 *  Empty list means "no defenses" — every target takes the full hit. */
function allowedDefensesFor(item) {
    const d = item.system?.bombDefenses ?? {};
    const list = [];
    if (d.block)      list.push("block");
    if (d.reposition) list.push("reposition");
    return list;
}

/** Consume 1 from the bomb's stack, if consumeOnThrow is set. When
 *  the stack hits zero, the item is DELETED via the parent actor's
 *  deleteEmbeddedDocuments — same path consumeMixin uses. Explicit
 *  parent-scoped delete avoids the silent-fail cases `item.delete()`
 *  can hit on embedded documents where the caller isn't recognized
 *  as owner of the embed path (permission proxy quirk). */
async function consumeBombIfNeeded(item) {
    if (!item.system?.consumeOnThrow) return;
    const qty = Math.max(0, Number(item.system?.quantity) || 0);
    if (qty <= 0) return;
    const next = qty - 1;
    if (next <= 0) {
        const actor = item.parent ?? item.actor ?? null;
        try {
            if (actor && item.id) {
                await actor.deleteEmbeddedDocuments("Item", [item.id]);
            } else {
                await item.delete();
            }
        } catch (err) {
            console.warn(`${MODULE} | bomb delete-on-consume failed for ${item?.name}`, err);
        }
    } else {
        await item.update({ "system.quantity": next });
    }
}

/** Build the flat HTML fragment appended to the roll's chat card
 *  summarising per-victim outcomes. */
function buildVerdictFragment({ victimResults, scatter, damageFormula, damageTypes, throwTotal, offhand, fallback }) {
    const rows = victimResults.map(v => {
        const action  = v.defenseChoice?.action ?? "none";
        const defTot  = Number(v.defenseChoice?.defenseTotal);
        const hasTot  = Number.isFinite(defTot);
        const chips   = Array.isArray(v.defenseChoice?.defenseChips) ? v.defenseChoice.defenseChips : [];
        const attempted = action && action !== "none";
        const defLabel = attempted
            ? t(`WITCHER.App.DefensePromptDialog.Defense.${action}`, action)
            : t("WITCHER.Mech.Bombs.Text.NoDefense", "No defense");
        /* Full modifier breakdown — pull the defense chips (STAT / SKILL /
         * MOD / STATUS / etc.) captured on the defense roll and render as
         * "STAT+X SKILL+Y MOD-Z" so the card explains the total, not just
         * shows it. */
        let breakdown = "";
        if (chips.length) {
            breakdown = chips.map(c => `${escapeHtml(String(c.label ?? ""))} ${escapeHtml(String(c.value ?? ""))}`).join(" · ");
            breakdown = ` <span style="opacity:0.6;font-size:0.85em;">[${breakdown}]</span>`;
        }
        const compare = (attempted && hasTot)
            ? tFormat("WITCHER.Mech.Bombs.Text.Compare", { def: defTot, thr: throwTotal }, "{def} vs {thr}")
            : "";
        let outcome;
        if (v.beat) {
            outcome = t("WITCHER.Mech.Bombs.Text.Avoided", "avoided");
        } else if (v.stuckInAoE) {
            outcome = t("WITCHER.Mech.Bombs.Text.StuckInAoENoDmg",
                        "still in blast — damage per location follows");
        } else {
            outcome = t("WITCHER.Mech.Bombs.Text.EatsBlast",
                        "eats the blast — damage per location follows");
        }
        const compareChip = compare ? ` <span style="opacity:0.75;">(${escapeHtml(compare)})</span>` : "";
        return `<li><b>${escapeHtml(v.actor.name)}</b> — ${escapeHtml(defLabel)}${compareChip}${breakdown} — ${escapeHtml(outcome)}</li>`;
    }).join("");
    const modChips = [];
    if (offhand)  modChips.push(`<span style="opacity:0.8;color:#b97;">${escapeHtml(t("WITCHER.Mech.Bombs.Text.OffHand", "Off-hand −3"))}</span>`);
    if (fallback) modChips.push(`<span style="opacity:0.75;">${escapeHtml(t("WITCHER.Mech.Bombs.Text.Narrative", "Narrative resolution — no template"))}</span>`);
    const modLine = modChips.length ? `<div style="margin-top:0.15rem;">${modChips.join(" · ")}</div>` : "";
    let scatterLine = "";
    if (scatter) {
        const line = tFormat("WITCHER.Mech.Bombs.Text.ScatteredBy",
                             { dist: scatter.distanceMeters, angle: scatter.angleDeg },
                             "Fumble scattered {dist}m at {angle}°");
        scatterLine = `<div style="margin-top:0.25rem;color:#b97;">${escapeHtml(line)}</div>`;
    }
    /* Bombs hit every body location separately (RAW p.155). Each
     * location's damage roll + SP filter shows as its own applied-to
     * card below (folded via attackMessageUuid). We only note the
     * formula here so the reader knows what's being rolled six times. */
    const dmgLine = victimResults.length && damageFormula
        ? `<div style="margin-top:0.15rem;opacity:0.8;">` +
              escapeHtml(tFormat("WITCHER.Mech.Bombs.Text.PerLocationRolls",
                                 { formula: damageFormula, types: damageTypes.join(", ") || "—" },
                                 "{formula} rolled per body location ({types})")) +
          `</div>`
        : "";
    const header = `<div style="font-weight:700;margin-top:0.25rem;">` +
                      escapeHtml(t("WITCHER.Mech.Bombs.Text.Detonation", "Detonation")) +
                   `</div>`;
    return header + modLine + scatterLine + dmgLine +
           (rows.length ? `<ul style="margin:0.25rem 0 0 1rem;padding:0;">${rows}</ul>` : "");
}

function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, c => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[c]);
}

/** Roll the bomb's damage formula once for the whole AoE. */
async function rollBombDamage(item) {
    const formula = String(item.system?.damage ?? "").trim();
    if (!formula) return { total: 0, roll: null };
    try {
        const r = await new Roll(formula).evaluate();
        return { total: Number(r.total) || 0, roll: r };
    } catch (err) {
        console.warn(`${MODULE} | bomb damage roll failed for "${formula}"`, err);
        return { total: 0, roll: null };
    }
}

/** RAW p.165 + p.155: "Everyone in that area takes the bomb's damage
 *  to every part of their body ... calculate full dice damage for each
 *  location separately." Six human body locations, each getting a
 *  fresh damage roll, each filtered by that location's own SP. */
const BOMB_LOCATIONS = Object.freeze(["head", "torso", "rightArm", "leftArm", "rightLeg", "leftLeg"]);


/** Apply main damage (per-location) + weapon-quality riders + per-
 *  effect application damage + rider AEs to one victim. */
async function applyBombToVictim({ victim, item, attacker, damageFormula, damageTypes, rollTotal, msgUuid, qualities, qualityValues }) {

    /* Pre-post a per-victim outer <details> so all per-location
     * damage breakdowns (and the raw-rolls summary) land NESTED
     * inside it. Reader clicks the victim's card to expand the
     * whole packet (rolls + per-location breakdowns). */
    const victimAnchor = `wdm-bomb-victim-${victim.id ?? victim.uuid.replace(/[^a-zA-Z0-9]/g, "_")}-${Date.now()}`;
    if (msgUuid) {
        const outerHtml =
            `<details class="wdm-attack-applied wdm-bomb-victim" data-bomb-victim="${victimAnchor}" style="margin-top:0.15rem;">` +
                `<summary><strong>${escapeHtml(victim.name)}</strong> — ${escapeHtml(t("WITCHER.Mech.Bombs.Text.BombDamagePacket", "bomb damage packet"))}</summary>` +
                `<div class="wdm-bomb-victim-body">` +
                    `<div class="wdm-bomb-victim-locs" data-bomb-victim-locs="${victimAnchor}"></div>` +
                `</div>` +
            `</details>`;
        try { await emitAppendAttackFragment({ attackMessageUuid: msgUuid, fragment: outerHtml }); }
        catch (_) { /* soft-fail */ }
    }
    const wrapperSelector = msgUuid ? `[data-bomb-victim-locs="${victimAnchor}"]` : null;

    /* Per-location damage — one damage-apply per body location. Each
     * location gets its own damage roll (RAW p.155 "calculate full
     * dice damage for each location separately"). Damage payload
     * mirrors the melee/ranged pipeline (weaponDamage, locationKey,
     * locationLabel, qualities) so per-location SP / DR / resistance
     * / ablation / crit stages all run identically to any other
     * attack — same calculator, same actor + monster resistance
     * math, same audit trail.
     *
     * `qualityValues` is only threaded on the FIRST successful
     * per-location apply so applyQualityRiders (inside the socket
     * handler) fires ONCE per victim rather than six times. Damage
     * flags (ablating/armorPiercing) come from `qualities` which
     * IS threaded on every apply — those apply per-location. */
    let anyPenetrated = 0;
    const perLocRolls = [];
    if (damageFormula) {
        for (const loc of BOMB_LOCATIONS) {
            let locAmount = 0;
            try {
                const r = await new Roll(damageFormula).evaluate();
                locAmount = Number(r.total) || 0;
                perLocRolls.push({ loc, rolled: locAmount });
            } catch (err) {
                console.warn(`${MODULE} | bomb per-location damage roll failed for "${damageFormula}"`, err);
                continue;
            }
            if (locAmount <= 0) continue;
            const locLabel = t(`WITCHER.Attack.Loc${loc.charAt(0).toUpperCase()}${loc.slice(1)}`, loc);
            try {
                await emitApplyDamage({
                    targetUuid:        victim.uuid,
                    sourceUuid:        attacker?.uuid ?? null,
                    weaponUuid:        item.uuid,
                    weaponDamage:      locAmount,
                    damageTypes,
                    locationKey:       loc,
                    locationLabel:     locLabel,
                    qualities,           /* fires ablating/AP/etc. damage flags every location */
                    /* qualityValues intentionally omitted here — the
                     * socket handler's applyQualityRiders call gates
                     * on that specific location's finalDamage > 0,
                     * which fails when armor fully soaks the roll.
                     * The rider fires ONCE per victim below via a
                     * manual applyQualityRiders call. */
                    attackKind:        "bomb",
                    attackTotal:       rollTotal,
                    attackMessageUuid: msgUuid ?? null,
                    appendWrapperSelector: wrapperSelector,
                    suppressBreakdown: false
                });
                anyPenetrated += locAmount;
            } catch (err) {
                console.warn(`${MODULE} | bomb ${loc} damage apply failed on ${victim.name}`, err);
            }
        }
    }

    /* Raw-roll summary appended INSIDE the same per-victim container
     * so the reader can audit the 6 rolled totals alongside their
     * post-armor breakdowns. */
    if (msgUuid && perLocRolls.length) {
        const locRowsHtml = perLocRolls.map(r => {
            const label = t(`WITCHER.Attack.Loc${r.loc.charAt(0).toUpperCase()}${r.loc.slice(1)}`, r.loc);
            return `<li>${escapeHtml(label)}: <b>${r.rolled}</b> ${escapeHtml(t("WITCHER.Mech.Bombs.Text.Rolled", "rolled"))}</li>`;
        }).join("");
        const rollsHtml =
            `<details class="wdm-bomb-rolls" style="margin-top:0.35rem;">` +
                `<summary>${escapeHtml(t("WITCHER.Mech.Bombs.Text.BombRollsAllLocations", "bomb damage rolls (per location)"))}` +
                    ` <span style="opacity:0.7;">(${escapeHtml(damageFormula)} × ${perLocRolls.length})</span></summary>` +
                `<ul style="margin:0.15rem 0 0 1rem;padding:0;font-size:0.8125rem;">${locRowsHtml}</ul>` +
            `</details>`;
        try { await emitAppendAttackFragment({ attackMessageUuid: msgUuid, fragment: rollsHtml, wrapperSelector }); }
        catch (_) { /* soft-fail */ }
    }

    /* Weapon-quality riders — bomb-specific inline implementation
     * with full chat + console logging so we can see exactly which
     * qualities fired, which had no rider, and which rolls hit.
     * Bypasses applyQualityRiders(shared) because that gated on the
     * per-location apply's finalDamage and threaded through the
     * appendAttackResult queue in ways that were silently dropping
     * bomb-thrower rider chat lines. Chat output is gated on
     * msgUuid but STATUS APPLY still fires without it — a rider
     * missing its card line is a UX loss, not a mechanical one. */
    if (anyPenetrated > 0 && Array.isArray(qualities) && qualities.length) {
        const catalog = getActiveWeaponQualities?.() ?? WEAPON_QUALITIES;
        for (const key of qualities) {
            const entry  = catalog[key] ?? WEAPON_QUALITIES[key];
            const rider  = entry?.rider ?? null;

            if (!rider || !rider.statusId) {
                /* Passive quality — Ablating, AP, Silver, etc. Skip the
                 * chat noise; these already show in the per-location
                 * damage breakdown as SP chips / bypasses / bonus
                 * damage. Console log for debug only. */
                continue;
            }

            if (rider.kind === "auto") {
                try {
                    await emitApplyStatus({
                        targetUuid:        victim.uuid,
                        statusId:          rider.statusId,
                        action:            "apply",
                        attackMessageUuid: msgUuid
                    });
                } catch (err) { console.warn(`${MODULE} | rider "${key}" auto-apply failed`, err); }
                if (msgUuid) {
                    const line = `<div class="wdm-attack-rider is-hit">` +
                        `<i class="fa-solid fa-droplet"></i> ` +
                        `<strong>${escapeHtml(entry.labelEn ?? key)}</strong> — ` +
                        `<em>${escapeHtml(victim.name)}</em> · ` +
                        `<em>${escapeHtml(t("WITCHER.Mech.Bombs.Text.TookEffect", "took effect"))}</em>` +
                    `</div>`;
                    try { await emitAppendAttackFragment({ attackMessageUuid: msgUuid, fragment: line }); }
                    catch (_) { /* soft */ }
                }
                continue;
            }

            if (rider.kind === "percent") {
                const raw = qualityValues[key];
                const pct = Math.max(0, Math.min(100, Number(raw) || 0));
                if (pct <= 0) {
                    /* Chance not set — silent skip (no card noise). */
                    continue;
                }
                let rollTotal = 0;
                try {
                    const r = await new Roll("1d100").evaluate();
                    rollTotal = Number(r.total) || 0;
                } catch (err) { console.warn(`${MODULE} | rider "${key}" d100 roll failed`, err); continue; }
                const hit = rollTotal <= pct;
                if (msgUuid) {
                    const line = `<div class="wdm-attack-rider ${hit ? "is-hit" : "is-miss"}">` +
                        `<i class="fa-solid ${hit ? "fa-droplet" : "fa-droplet-slash"}"></i> ` +
                        `<strong>${escapeHtml(entry.labelEn ?? key)}</strong> — ` +
                        `<em>${escapeHtml(victim.name)}</em> · ` +
                        `<span class="wdm-attack-rider-roll">${rollTotal} / ${pct}%</span> · ` +
                        `<em>${escapeHtml(hit ? t("WITCHER.Mech.Bombs.Text.TookEffect", "took effect") : t("WITCHER.Mech.Bombs.Text.Shrugged", "shrugged off"))}</em>` +
                    `</div>`;
                    try { await emitAppendAttackFragment({ attackMessageUuid: msgUuid, fragment: line }); }
                    catch (_) { /* soft */ }
                }
                if (hit) {
                    try {
                        await emitApplyStatus({
                            targetUuid:        victim.uuid,
                            statusId:          rider.statusId,
                            action:            "apply",
                            attackMessageUuid: msgUuid
                        });
                    } catch (err) {
                        console.warn(`${MODULE} | rider "${key}" apply failed`, err);
                    }
                }
                continue;
            }

            /* stunSave and other kinds — defer to the shared handler
             * for consistency with melee/ranged behavior. */
            try {
                await applyQualityRiders(
                    victim, [key], qualityValues ?? {}, "torso",
                    ChatMessage.getSpeaker({ actor: attacker ?? null }),
                    { attackMessageUuid: msgUuid }
                );
            } catch (err) { console.warn(`${MODULE} | shared rider "${key}" failed`, err); }
        }
    }

    /* Bomb-native ablation — direct read from the bomb item's own
     * `bombArmorAblation` + `bombWeaponAblation` fields. Rolls each
     * formula ONCE per victim, decrements armor SP per location and
     * chips each equipped weapon's Reliability. No AE round-trip, no
     * tick dependency — this is bomb-authored damage that lands the
     * moment the bomb detonates on the victim. GM-only writes
     * (embedded document mutation needs GM ownership). */
    if (game.user?.isActiveGM && anyPenetrated > 0) {
        const armorRaw  = String(item.system?.bombArmorAblation  ?? "").trim();
        const weaponRaw = String(item.system?.bombWeaponAblation ?? "").trim();

        const rollExpr = async (expr) => {
            if (!expr) return 0;
            if (/d/i.test(expr)) {
                try { const r = await new Roll(expr).evaluate(); return Math.max(0, Math.floor(Number(r.total) || 0)); }
                catch (_) { return 0; }
            }
            const n = parseInt(expr, 10);
            return Number.isFinite(n) ? Math.max(0, n) : 0;
        };

        let armorChipped = 0, weaponsChipped = 0;
        const armorAmt = await rollExpr(armorRaw);
        if (armorAmt > 0) {
            /* RAW p.165 bomb rule: damage hits every body location.
             * Chip the same amount off each of the six per-location
             * armor SP fields. Monster natural armor is a flat pool
             * — one chip covers all locations. */
            if (victim.type === "monster") {
                for (let k = 0; k < armorAmt; k++) {
                    try { await decrementArmorSP(victim, "torso"); armorChipped++; }
                    catch (err) { console.warn(`${MODULE} | monster ablate failed`, err); }
                }
            } else {
                for (const loc of BOMB_LOCATIONS) {
                    for (let k = 0; k < armorAmt; k++) {
                        try { await decrementArmorSP(victim, loc); armorChipped++; }
                        catch (err) { console.warn(`${MODULE} | armor ablate failed on ${loc}`, err); }
                    }
                }
            }
        }
        const weaponAmt = await rollExpr(weaponRaw);
        if (weaponAmt > 0) {
            const equipped = (victim.items ?? []).filter(i =>
                (i.type === "weapon" || i.type === "shield") && i.system?.equipped);
            for (const w of equipped) {
                const cur = Number(w.system?.reliability?.value) || 0;
                const max = Number(w.system?.reliability?.max)   || 0;
                if (max <= 0 || cur <= 0) continue;
                if (await durableAblationNegated(w, { actor: victim })) continue;   // Durable rune save
                const next = Math.max(0, cur - weaponAmt);
                if (next !== cur) {
                    try { await w.update({ "system.reliability.value": next }); weaponsChipped++; }
                    catch (err) { console.warn(`${MODULE} | weapon ablate failed on ${w.name}`, err); }
                }
            }
        }

        /* Chat chip so the reader sees ablation landed. */
        if (msgUuid && (armorChipped > 0 || weaponsChipped > 0)) {
            const parts = [];
            if (armorChipped   > 0) parts.push(tFormat("WITCHER.Mech.Bombs.Text.ChippedArmor",   { n: armorChipped   }, "chipped {n} armor SP"));
            if (weaponsChipped > 0) parts.push(tFormat("WITCHER.Mech.Bombs.Text.ChippedWeapons", { n: weaponsChipped }, "chipped {n} weapon Reliability"));
            const line = `<div class="wdm-attack-rider is-hit">` +
                `<i class="fa-solid fa-shield-halved"></i> ` +
                `<em>${escapeHtml(victim.name)}</em> · ${escapeHtml(parts.join(", "))}` +
            `</div>`;
            try { await emitAppendAttackFragment({ attackMessageUuid: msgUuid, fragment: line }); }
            catch (_) { /* soft */ }
        }
    }

    /* Authored bomb effects — each embedded AE authored via the sheet's
     * Add Effect / Add Status. Application chance (`bombRiderChance`
     * flag, %) gates spawning per-victim; application damage
     * (`bombRiderDamage` flag, formula) rolls a separate damage hit. */
    const effects = item.effects?.contents ?? [];
    if (!effects.length) return;
    const payloads = [];
    for (const ae of effects) {
        if (ae.disabled) continue;

        /* Application-chance gate. Missing / 0 / non-numeric = auto-apply
         * (100% chance). If set to N, roll d100 and only proceed on ≤N.
         * Both application damage AND the AE clone are gated by the
         * same roll — they represent the same "the effect took hold"
         * moment. Chat card gets a line for every gated effect so the
         * player sees "Burning · 42 / 50% · applies" or "no effect". */
        const chanceRaw = String(ae.flags?.[MODULE]?.bombRiderChance ?? "").trim();
        const chance    = chanceRaw ? Math.max(0, Math.min(100, Number(chanceRaw) || 0)) : 100;
        let applies  = true;
        let chanceRollTotal = null;
        if (chance < 100) {
            try {
                const cr = await new Roll("1d100").evaluate();
                chanceRollTotal = Number(cr.total);
                applies = chanceRollTotal <= chance;
            } catch (_) { applies = false; }
        }
        /* Always post a rider line — including 100% auto-applies —
         * so the reader sees every attached effect on the card, not
         * just the gated ones. Otherwise a 100% "Deafened" rider
         * spawns silently and looks like it's not working. */
        if (msgUuid) {
            const rollText = chance < 100
                ? `<span class="wdm-attack-rider-roll">${chanceRollTotal} / ${chance}%</span> · `
                : `<span class="wdm-attack-rider-roll">${chance}% ${escapeHtml(t("WITCHER.Mech.Bombs.Text.AutoApply", "auto"))}</span> · `;
            const line =
                `<div class="wdm-attack-rider ${applies ? "is-hit" : "is-miss"}">` +
                    `<i class="fa-solid ${applies ? "fa-droplet" : "fa-droplet-slash"}"></i> ` +
                    `<strong>${escapeHtml(ae.name)}</strong> — <em>${escapeHtml(victim.name)}</em> · ` +
                    rollText +
                    `<em>${escapeHtml(applies ? t("WITCHER.Doc.WeaponAttackMixin.Text.Applies", "applies") : t("WITCHER.Doc.WeaponAttackMixin.Text.NoEffect", "no effect"))}</em>` +
                `</div>`;
            try { await emitAppendAttackFragment({ attackMessageUuid: msgUuid, fragment: line }); }
            catch (_) { /* soft-fail */ }
        }
        if (!applies) continue;

        /* Application damage — optional per-effect formula. */
        const dmgFormula = String(ae.flags?.[MODULE]?.bombRiderDamage ?? "").trim();
        if (dmgFormula) {
            try {
                const r = await new Roll(dmgFormula).evaluate();
                const rTotal = Number(r.total) || 0;
                if (rTotal > 0) {
                    await emitApplyDamage({
                        targetUuid: victim.uuid,
                        sourceUuid: attacker?.uuid ?? null,
                        weaponUuid: item.uuid,
                        amount: rTotal,
                        damageTypes,
                        hitLocation: null,
                        attackKind: "bomb",
                        attackTotal: rollTotal,
                        attackMessageUuid: msgUuid ?? null
                    });
                }
            } catch (err) {
                console.warn(`${MODULE} | bomb rider "${ae.name}" damage roll failed for "${dmgFormula}"`, err);
            }
        }
        /* AE payload — minimal clone. Delete _id and clear any
         * inherited start-time metadata so Foundry auto-populates
         * startRound/startTurn/startTime at create time for the
         * NEW parent (the victim). This matches how a freshly-
         * created AE from a macro / direct createEmbeddedDocuments
         * would behave — the tick engine + expiry math both key off
         * the auto-populated fields, not our stamped ones.
         *
         * Origin = ITEM UUID (bomb weapon) so `willApplyToActor`
         * resolves via the item→actor parent chain. transfer=false
         * so the AE lives on the victim directly rather than being
         * treated as a transferred-from-item buff. */
        const cloned = foundry.utils.deepClone(ae.toObject());
        delete cloned._id;
        cloned.origin   = item.uuid;
        cloned.transfer = false;
        if (cloned.duration) {
            /* Strip inherited start metadata — Foundry recomputes
             * these on createEmbeddedDocuments so remaining is
             * measured from NOW, not from the AE's original author
             * timestamp on the bomb item. */
            delete cloned.duration.startTime;
            delete cloned.duration.startRound;
            delete cloned.duration.startTurn;
        }
        payloads.push(cloned);
    }
    if (payloads.length) {
        try {
            /* GM throwers can call createEmbeddedDocuments directly on
             * the target — matches the exact code path oils use
             * (socketHook.mjs handleApplyDamage) which is confirmed
             * to spawn ticking rider AEs correctly. Non-GM throwers
             * route through the socket (same handler on GM). */
            if (game.user?.isActiveGM && victim.createEmbeddedDocuments) {
                await victim.createEmbeddedDocuments("ActiveEffect", payloads);
            } else {
                await emitApplyAuthoredEffects({ targetUuid: victim.uuid, payloads });
            }
        } catch (err) {
            console.warn(`${MODULE} | bomb rider apply failed on ${victim.name}`, err);
        }
    }
}

/** Roll Athletics for the throw, applying the off-hand penalty and the
 *  RAW range-band modifier (+5 point-blank, 0 close, −2 medium, −5
 *  long). Longer throw = lower Athletics total = defenders' opposed
 *  rolls are easier to beat — the "they saw it coming" model.
 *  Returns the extendedRoll result. Null on failure. */
async function rollThrow(actor, item, { offhand, maxRangeM = null, rangeMod = 0, rangeBand = null }) {
    const skillKey = String(item.system?.skillKey || "athletics");
    const v = actor._readSkillValues?.(skillKey);
    const total = Number(v?.total ?? 0) || 0;
    const offMod = offhand ? hrOffhandPenalty() : 0;
    const netTotal = total + offMod + (Number(rangeMod) || 0);
    const formula = `1d10${netTotal >= 0 ? "+" : ""}${netTotal}`;
    /* Flavor line — bomb name + skill + range + explicit modifier
     * chain so drift (wounds/encumbrance) and per-throw mods
     * (off-hand, range) are visible. */
    const rangeTag = Number.isFinite(maxRangeM) && maxRangeM > 0
        ? ` · ${maxRangeM}m ${t("WITCHER.Sheet.Weapon.Text.Range", "Range")}`
        : "";
    const bandTag = rangeBand
        ? ` · ${t(`WITCHER.Mech.Bombs.Band.${rangeBand}`, rangeBand)}${rangeMod ? ` (${rangeMod > 0 ? "+" : ""}${rangeMod})` : ""}`
        : "";
    const offhandTag = offhand ? ` (${t("WITCHER.Mech.Bombs.Text.OffHand", "Off-hand −3")})` : "";
    const flavor = tFormat("WITCHER.Mech.Bombs.Text.ThrowFlavor",
                           { name: item.name, skill: skillKey },
                           "Throws {name} — {skill} check")
                 + rangeTag + bandTag + offhandTag;
    return extendedRoll(
        formula,
        {
            speaker: ChatMessage.getSpeaker({ actor }),
            flavor,
            flags: (r) => ({
                [MODULE]: {
                    category:     "combat",
                    bomb:         true,
                    attackerUuid: actor.uuid,
                    attackerName: actor.name,
                    bombItemUuid: item.uuid,
                    attackTotal:  r.total
                }
            })
        },
        { fumbleCategory: "gear" }
    );
}

/** Gather fallback victims when there's no canvas token to place a
 *  template from. Prefers canvas-targeted tokens (`game.user.targets`);
 *  falls back to combat-tracker actor targets. Deduped by actor uuid,
 *  attacker excluded. Returns [] if nothing is targeted. */
async function gatherFallbackVictims(actor) {
    const seen = new Set();
    const out  = [];
    for (const t of (game.user?.targets ?? [])) {
        const a = t?.actor;
        if (!a || a === actor || seen.has(a.uuid)) continue;
        seen.add(a.uuid); out.push(a);
    }
    if (!out.length) {
        try {
            const tokenless = await getActorTargets();
            for (const a of (tokenless ?? [])) {
                if (!a || a === actor || seen.has(a.uuid)) continue;
                seen.add(a.uuid); out.push(a);
            }
        } catch (_) { /* soft-fail — no candidates */ }
    }
    return out;
}

/** Test if a token still overlaps a captured AoE shape (post-reposition).
 *  Shape is in template-local coords, so translate the token's cell into
 *  the shape's frame before hit-testing. Returns true when the token's
 *  footprint intersects the shape. Falls open (true — assume still
 *  inside) on any failure so an unmovable/undetectable token isn't
 *  auto-excused. */
function tokenStillInAoE(token, captured) {
    if (!token || !captured?.shape) return true;
    const grid = canvas?.grid;
    const gridSize = Number(grid?.size) || 100;
    const tw = Number(token.document?.width)  || 1;
    const th = Number(token.document?.height) || 1;
    const tx = Number(token.document?.x) ?? Number(token.x) ?? 0;
    const ty = Number(token.document?.y) ?? Number(token.y) ?? 0;
    const cx = tx + (tw * gridSize) / 2;
    const cy = ty + (th * gridSize) / 2;
    const originX = Number(captured?.x) || 0;
    const originY = Number(captured?.y) || 0;
    const halfW = (tw * gridSize) / 2;
    const halfH = (th * gridSize) / 2;
    /* PIXI shapes carry a `contains(x, y)` local-space test. Probe the
     * cell centre + 4 corners — any inside means the shape still touches
     * the token. Same conservative 3-part semantics harvestTokens uses
     * at throw time. */
    const pts = [
        [cx,           cy          ],
        [cx - halfW,   cy - halfH  ],
        [cx + halfW,   cy - halfH  ],
        [cx + halfW,   cy + halfH  ],
        [cx - halfW,   cy + halfH  ]
    ];
    for (const [px, py] of pts) {
        try {
            const lx = px - originX;
            const ly = py - originY;
            if (captured.shape.contains?.(lx, ly)) return true;
        } catch (_) { /* soft-fail; assume outside for this point */ }
    }
    return false;
}

/** Common per-victim resolution used by both canvas + fallback flows:
 *  fan out defense prompts, roll damage once, apply per victim, append
 *  the verdict fragment to the roll's chat card. */
async function resolveVictims({ actor, item, victims, throwResult, scatter, offhand, fallback, captured = null }) {
    const msg = throwResult?.message ?? null;
    const rollTotal = Number(throwResult?.total) || 0;
    const allowed = allowedDefensesFor(item);
    const engagementId = `bombEng-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    let defenderResults = [];
    if (allowed.length && victims.length) {
        defenderResults = await Promise.all(victims.map(async (victim) => {
            let choice = { action: "none", defenseTotal: null };
            try {
                choice = await requestDefenseFromOwner({
                    defenderActor:       victim,
                    attackerName:        actor.name,
                    weaponName:          item.name,
                    weaponImg:           item.img,
                    engagementId,
                    attackKind:          "bomb",        /* new gate: strict shield-cover check (RAW Full Cover / CE CV ≥ 5) */
                    shotIndex:           1,
                    totalShots:          1,
                    disallowedItemIds:   [],
                    attackerDamageFlags: null,
                    attackHitLocation:   null,
                    allowedDefenses:     allowed,
                    requiresShieldCover: true
                }) ?? choice;
            } catch (err) {
                console.warn(`${MODULE} | bomb defense prompt failed on ${victim?.name}`, err);
            }
            return { actor: victim, defenseChoice: choice };
        }));
    } else {
        defenderResults = victims.map(v => ({ actor: v, defenseChoice: { action: "none", defenseTotal: null } }));
    }

    /* Damage formula + quality set passed per-victim so the applier
     * can roll fresh per body location and thread quality damage
     * flags (ablating, armorPiercing, etc.) into each hit. Fall back
     * to `effective.qualities/qualityValues` (post-enhancement) when
     * the base fields are empty — a runed bomb could carry qualities
     * only in the derived shape. */
    const damageFormula = String(item.system?.damage ?? "").trim();
    const damageTypes   = Array.isArray(item.system?.damageTypes) ? item.system.damageTypes.slice() : [];
    const baseQualities = Array.isArray(item.system?.qualities) ? item.system.qualities : [];
    const effQualities  = Array.isArray(item.system?.effective?.qualities) ? item.system.effective.qualities : [];
    const qualities     = (baseQualities.length ? baseQualities : effQualities).slice();
    const baseQVals     = item.system?.qualityValues ?? {};
    const effQVals      = item.system?.effective?.qualityValues ?? {};
    /* Merge: effective wins per-key when set, otherwise base. */
    const qualityValues = { ...baseQVals, ...effQVals };

    /* LOUD chat diagnostic — posted BEFORE any per-victim work so
     * the user sees exactly what the throw is going to hand to the
     * damage / rider pipeline. If `qualities` here is empty on a
     * bomb you TOGGLED "Fire" on, the sheet's checkbox isn't
     * persisting — inspect item._source.system.qualities in the
     * console: if THAT'S also empty, the form submit dropped it.
     * Remove this diagnostic once verified. */
    if (msg?.uuid && (qualities.length || Object.keys(qualityValues).length)) {
        const qList = qualities.length
            ? qualities.map(k => {
                const v = qualityValues[k];
                return v != null && v !== "" ? `${k}(${v})` : k;
              }).join(", ")
            : "—";
        const diag = `<div style="margin-top:0.25rem;padding:0.2rem 0.4rem;background:rgba(200,168,120,0.12);border:1px dashed #c8a878;border-radius:3px;font-size:0.6875rem;font-family:var(--wdm-font-mono, monospace);">` +
            `<b>${escapeHtml(t("WITCHER.Mech.Bombs.Text.QualitiesFromItem", "Bomb qualities on this throw"))}:</b> ${escapeHtml(qList)}` +
            `</div>`;
        try { await emitAppendAttackFragment({ attackMessageUuid: msg.uuid, fragment: diag }); }
        catch (_) { /* soft-fail */ }
    } else if (msg?.uuid) {
        /* Explicit note when the throw carries NO qualities — so the
         * user isn't left wondering why Fire didn't fire. */
        const diag = `<div style="margin-top:0.25rem;padding:0.2rem 0.4rem;background:rgba(255,120,120,0.12);border:1px dashed #b97;border-radius:3px;font-size:0.6875rem;">` +
            `<b>${escapeHtml(t("WITCHER.Mech.Bombs.Text.NoQualitiesOnItem", "This bomb has no weapon qualities — check the Qualities section on the config sheet."))}</b>` +
            `</div>`;
        try { await emitAppendAttackFragment({ attackMessageUuid: msg.uuid, fragment: diag }); }
        catch (_) { /* soft-fail */ }
    }

    for (const v of defenderResults) {
        const action  = v.defenseChoice?.action ?? "none";
        const defTot  = Number(v.defenseChoice?.defenseTotal);
        const attempted = action && action !== "none";
        let beat = attempted && Number.isFinite(defTot) && defTot >= rollTotal;
        /* Reposition-distance check (canvas mode only). Same as
         * before — see tokenStillInAoE. */
        if (beat && action === "reposition" && captured && !fallback) {
            const token = v.actor?.getActiveTokens?.()?.[0] ?? null;
            const stillInside = tokenStillInAoE(token, captured);
            if (stillInside) {
                beat = false;
                v.stuckInAoE = true;
            }
        }
        v.beat = !!beat;
        if (beat) continue;
        await applyBombToVictim({
            victim: v.actor, item, attacker: actor,
            damageFormula, damageTypes, rollTotal,
            qualities, qualityValues,
            msgUuid: msg?.uuid ?? null
        });
    }

    await consumeBombIfNeeded(item);

    if (msg) {
        try {
            const verdict = buildVerdictFragment({
                victimResults: defenderResults,
                scatter,
                damageFormula,
                damageTypes,
                throwTotal: rollTotal,
                offhand, fallback
            });
            await emitAppendAttackFragment({
                attackMessageUuid: msg.uuid,
                fragment: verdict
            });
        } catch (err) {
            console.warn(`${MODULE} | bomb verdict append failed`, err);
        }
    }
}

/** Public entry — dispatch a bomb throw. Called from
 *  `weaponAttackMixin.weaponAttack` when the equipped weapon is a
 *  bomb. Returns null on any early exit; the caller doesn't inspect
 *  the return value. */
export async function throwBomb(actor, item) {
    if (!actor || !item) return null;
    if (item.type !== "weapon" || item.system?.weaponType !== "bomb") return null;

    const qty = Math.max(0, Number(item.system?.quantity) || 0);
    if (qty <= 0) {
        ui.notifications?.warn(t("WITCHER.Mech.Bombs.Notify.OutOfStock", "You're out of that bomb."));
        return null;
    }
    if (!item.system?.equipped) {
        ui.notifications?.warn(t("WITCHER.Mech.Bombs.Notify.NotEquipped", "Equip the bomb before throwing it."));
        return null;
    }

    const offhand = isOffhandWeapon(item);

    /* Canvas mode requires the caster to have an active token on the
     * scene. Without one there's nothing to project range / origin
     * from — fall through to the target-list path. */
    const casterToken = actor.getActiveTokens?.()?.[0] ?? null;
    const canvasMode  = !!canvas?.scene && !!canvas?.ready && !!casterToken;

    if (canvasMode) {
        /* Compute max throw range in pixels. Null / 0 = no range
         * constraint (bomb has no `range` value or unparseable).
         * Extreme range = 2× listed (RAW Core p.152 range table).
         * Passed to the placer so the outer boundary shows as a
         * fainter ring and the clamp allows throws up to 2× — the
         * range-band penalty (-6 at extreme) is the deterrent. */
        const maxRangeM      = await resolveBombRangeMetres(item, actor);
        const maxRangePx     = maxRangeM ? metresToPixels(maxRangeM) : null;
        const extremeRangePx = maxRangeM ? metresToPixels(maxRangeM * 2) : null;

        /* Placement first — cancel here aborts the entire throw
         * (no roll, no consume). */
        const landing = await pickBombLanding(actor, item, { maxRangePx, extremeRangePx });
        if (!landing) return null;

        /* Compute range band from thrower→landing BEFORE rolling. The
         * band modifier folds into the Athletics total so long throws
         * are easier to defend against (physical reality: more
         * reaction time). No "landing-accuracy DC" gate — the bomb
         * lands where the player clicked. Only a fumble scatters. */
        const throwerCenter = casterToken?.center ?? { x: 0, y: 0 };
        const distPx = Math.hypot(landing.captured.x - throwerCenter.x,
                                    landing.captured.y - throwerCenter.y);
        const distM  = pixelsToMetres(distPx);
        const band   = rangeBandFor(distM, maxRangeM);

        const throwResult = await rollThrow(actor, item, {
            offhand, maxRangeM,
            rangeMod:  band.mod,
            rangeBand: band.band
        });
        if (!throwResult) return null;

        /* Fumble → scatter (spectacle: the throw goes wild). The RAW
         * "miss = scatter" gate is retired — with defenders opposing
         * the roll individually AND the range modifier already
         * making long throws harder to land, a separate landing DC
         * doubles friction. Per user 2026-07-25: keep the modifier,
         * drop the DC. */
        let scatter = null;
        let effX = landing.captured.x, effY = landing.captured.y;
        if (throwResult.fumble) {
            scatter = await rollScatter();
            scatter.distM = Math.round(distM * 10) / 10;
            const off = scatterOffsetPixels(scatter.distanceMeters, scatter.angleDeg);
            effX += off.dx;
            effY += off.dy;
            /* Scatter can't pass through a wall — if the fumble direction sends
             * the bomb into a wall, it stops at the wall face instead of
             * teleporting past it. Clamp the landing→scattered segment to the
             * closest move-blocking wall, backed off ~0.4 cells so the blast
             * centre sits on the near side. */
            try {
                const backend = CONFIG?.Canvas?.polygonBackends?.move;
                if (backend?.testCollision) {
                    const from = { x: landing.captured.x, y: landing.captured.y };
                    const to   = { x: effX, y: effY };
                    const hit  = backend.testCollision(from, to, { type: "move", mode: "closest" });
                    if (hit && Number.isFinite(hit.x) && Number.isFinite(hit.y)) {
                        const ddx = to.x - from.x, ddy = to.y - from.y;
                        const len = Math.hypot(ddx, ddy) || 1;
                        const backoff = Math.min(len, (Number(canvas?.grid?.size) || 100) * 0.4);
                        effX = hit.x - (ddx / len) * backoff;
                        effY = hit.y - (ddy / len) * backoff;
                    }
                }
            } catch (_) { /* wall clamp is best-effort */ }
            /* Visual feedback — drop a temporary scene-persistent Region
             * at the SCATTERED hex so players see where the bomb actually
             * landed vs. where the thrower aimed. Red tint to distinguish
             * from a normal preview. Auto-deletes after 5s so the canvas
             * doesn't accumulate ghost markers from every fumbled throw.
             * GM-only writes since createEmbeddedDocuments on the scene
             * needs owner permission. Sized from the bomb's own area config
             * (same math pickBombLanding used to build the preview) rather
             * than from the captured PIXI shape, which stores geometry in
             * local coords not distance units.
             *
             * Native Region (not MeasuredTemplate): the MeasuredTemplate
             * document was merged into Region in v14, and going through the
             * deprecation shim spammed warnings + lazily built a synthetic
             * placeable. `buildTemplateRegionData` (shared with persistent
             * zones) produces a Region whose shape is byte-identical to what
             * the old template rendered. No zoneEffect flag → the zone
             * enter/exit engine ignores it; it's a pure visual marker. */
            if (game.user?.isActiveGM && canvas?.scene) {
                try {
                    const area = resolveBombArea(item);
                    if (area) {
                        const flashElev = Number(landing.captured.elevation) || 0;
                        const templateData = {
                            t:         area.foundryType,
                            user:      game.user?.id ?? null,
                            distance:  area.foundryType === "cone" ? area.size * Math.SQRT2 : area.size,
                            direction: Number(landing.captured.direction) || 0,
                            x:         effX,
                            y:         effY,
                            elevation: flashElev,
                            fillColor: "#c04040",
                            itemName:  item.name,
                            flags:     { [MODULE]: { bombScatter: true } }
                        };
                        if (area.foundryType === "cone") templateData.angle = 90;
                        if (area.foundryType === "ray")  templateData.width = 1;
                        const regionData = buildTemplateRegionData(templateData, { elevation: flashElev });
                        if (regionData) {
                            const [placed] = await canvas.scene.createEmbeddedDocuments("Region", [regionData]);
                            if (placed?.id) {
                                setTimeout(() => {
                                    try { canvas.scene?.deleteEmbeddedDocuments("Region", [placed.id]); }
                                    catch (_) { /* scene / region already gone — soft-fail */ }
                                }, 5000);
                            }
                        }
                    }
                } catch (err) {
                    console.warn(`${MODULE} | scatter-region flash failed`, err);
                }
            }
        }
        /* Thrower NOT excluded — if the AoE (post-scatter) catches
         * the thrower's own token, they eat the blast too. Common
         * cases: point-blank throws, fumbles that scatter the bomb
         * back to your feet, throwing into a doorway you're standing
         * in. The thrower still gets their own defense prompt like
         * any other victim. */
        const victims = harvestTokens({
            shape:     landing.captured.shape,
            x:         effX,
            y:         effY,
            elevation: landing.captured.elevation
        }, {}).filter(a => !!a);

        /* Capture object with the shape shifted to the effective (post-
         * scatter) origin so the reposition check works against the
         * actual detonation hex, not the pre-scatter aim point. */
        const scatteredCaptured = { ...landing.captured, x: effX, y: effY };
        await resolveVictims({
            actor, item, victims, throwResult,
            scatter, offhand, fallback: false,
            captured: scatteredCaptured
        });
        return null;
    }

    /* Fallback: no active caster token. Get victims from user.targets
     * or combat tracker. Confirm with the player if nothing's targeted
     * — same courtesy the standard weapon attack extends. */
    let victims = await gatherFallbackVictims(actor);
    if (!victims.length) {
        const DialogV2 = foundry?.applications?.api?.DialogV2 ?? null;
        let go = false;
        if (DialogV2) {
            try {
                go = await DialogV2.confirm({
                    window: { title: t("WITCHER.Mech.Bombs.Dialog.Title.NoTargets", "Throw without a target?") },
                    content: `<p>${escapeHtml(t("WITCHER.Mech.Bombs.Text.NoTargetsPrompt",
                        "No targets are selected. Roll the throw anyway (narrative only)?"))}</p>`,
                    rejectClose: false
                });
            } catch (_) { go = false; }
        } else {
            go = window.confirm(t("WITCHER.Mech.Bombs.Text.NoTargetsPrompt",
                "No targets are selected. Roll the throw anyway (narrative only)?"));
        }
        if (!go) return null;
    }

    const throwResult = await rollThrow(actor, item, { offhand });
    if (!throwResult) return null;

    /* No template = no scatter geometry to offset in fallback. The
     * fumble still shows on the roll card via extendedRoll's own
     * fumble banner; a bomb thrown blind in theatre-of-mind can be
     * scattered by GM narration. */
    await resolveVictims({
        actor, item, victims, throwResult,
        scatter: null, offhand, fallback: true
    });
    return null;
}
