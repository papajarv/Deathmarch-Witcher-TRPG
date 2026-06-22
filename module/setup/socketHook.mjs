/**
 * registerSocket — wires socket listeners for GM-proxied actions during `ready`.
 *
 * Pattern: player clients emit messages with a `type` discriminator on the
 * system channel `system.witcher-ttrpg-death-march`; the GM client handles
 * them. Used for cross-actor updates that players lack permission to perform
 * directly (rewarding IP from a chat card, applying damage / status to
 * tokens owned by others, etc.).
 *
 * Adding a new message type:
 *   1. Define a sender helper in this file (`export async function emitX(...)`)
 *      so callers don't construct payloads by hand.
 *   2. Add a case to `handleSocketMessage`.
 *   3. Implement the handler — at minimum, validate inputs and update the
 *      target document.
 *
 * Phase 6 covers the registration + the most common messages (damage,
 * IP grant). More types land alongside Phase 7's mechanic port.
 */

import { drainHp, ATTACK_LOCATIONS, getActiveWeaponQualities, WEAPON_QUALITIES } from "./config.mjs";
import { resolveDamage } from "../combat/damageCalculator.mjs";
import { renderDamageBreakdown } from "../combat/damageBreakdown.mjs";
import { autoApplyCriticalWound } from "../chrome/chrome/critical-roll.js";
import { applyQualityRiders, appendAttackResult } from "../documents/mixins/weaponAttackMixin.mjs";

const SYSTEM_ID = "witcher-ttrpg-death-march";
const CHANNEL = `system.${SYSTEM_ID}`;
const PARCHMENT_FLAG = "parchments";

export function registerSocket() {
    game.socket.on(CHANNEL, handleSocketMessage);
}

function handleSocketMessage(data) {
    // Farkle PvP traffic is peer-routed in minigames/farkle/net.mjs,
    // not GM-proxied; ignore it here so it doesn't trip the unknown warning.
    // `farkleLobby` is GM-authoritative but has its own listener in lobby.mjs.
    if (data?.type === "farkle" || data?.type === "farkleLobby") return;

    /* Direct user→user messages — gated on `recipientUserId` so a single
     * broadcast only acts on the addressed client. Defense prompt round-
     * trip lives here so it bypasses the GM-only gate below. */
    if (data?.type === "defenseRequest") {
        if (data.recipientUserId !== game.user?.id) return;
        return handleDefenseRequest(data);
    }
    if (data?.type === "defenseResponse") {
        if (data.recipientUserId !== game.user?.id) return;
        return handleDefenseResponse(data);
    }

    if (!game.user.isActiveGM) return;
    switch (data?.type) {
        case "applyDamage":       return handleApplyDamage(data);
        case "applyStatus":       return handleApplyStatus(data);
        case "reduceReliability": return handleReduceReliability(data);
        case "grantIP":           return handleGrantIP(data);
        case "grantReputation":   return handleGrantReputation(data);
        case "addSceneParchment": return handleAddSceneParchment(data);
        case "removeSceneParchment": return handleRemoveSceneParchment(data);
        default:
            console.warn(`${SYSTEM_ID} | unknown socket message`, data);
    }
}

/* -------------------------------------------------------------------------- */
/* Senders (call these from non-GM code)                                      */
/* -------------------------------------------------------------------------- */

/* Apply damage to a target.  Accepts the legacy shape (amount + type +
 * location label + throughArmor) AND the new richer shape (weaponDamage +
 * damageTypes array + locationKey + qualities + qualityValues + critBonus).
 * The handler converts whichever fields are present into the damage-
 * calculator's input shape and runs the full RAW pipeline. */
export function emitApplyDamage(payload) {
    if (game.user.isActiveGM) return handleApplyDamage(payload);
    game.socket.emit(CHANNEL, { type: "applyDamage", ...payload });
}

export function emitApplyStatus({ targetUuid, statusId, action = "toggle" }) {
    if (game.user.isActiveGM) return handleApplyStatus({ targetUuid, statusId, action });
    game.socket.emit(CHANNEL, { type: "applyStatus", targetUuid, statusId, action });
}

/* Reduce a weapon/shield's Reliability by 1 (floored at 0). Used to
 * auto-charge a Block defense after the attack resolves and shows the
 * Block beat the attack roll. Routed through the GM so the attacker's
 * client can trigger it without needing write permission on the
 * defender's item.
 *
 * `attackMessageUuid` (optional): when provided, the "absorbs a block"
 * notice folds INTO the attack card's collapsible result block
 * instead of posting a standalone chat message. */
export function emitReduceReliability({ itemUuid, attackMessageUuid = null }) {
    if (game.user.isActiveGM) return handleReduceReliability({ itemUuid, attackMessageUuid });
    game.socket.emit(CHANNEL, { type: "reduceReliability", itemUuid, attackMessageUuid });
}

export function emitGrantIP({ actorUuid, label, value }) {
    if (game.user.isActiveGM) return handleGrantIP({ actorUuid, label, value });
    game.socket.emit(CHANNEL, { type: "grantIP", actorUuid, label, value });
}

export function emitGrantReputation({ actorUuid, delta }) {
    if (game.user.isActiveGM) return handleGrantReputation({ actorUuid, delta });
    game.socket.emit(CHANNEL, { type: "grantReputation", actorUuid, delta });
}

/* Notice-board parchments: players can't write scene flags, so posting
 * (add) and swiping/removing a posting route through the GM client. */
export function emitAddSceneParchment({ sceneId, entry }) {
    if (game.user.isActiveGM) return handleAddSceneParchment({ sceneId, entry });
    game.socket.emit(CHANNEL, { type: "addSceneParchment", sceneId, entry });
}

export function emitRemoveSceneParchment({ sceneId, entryId }) {
    if (game.user.isActiveGM) return handleRemoveSceneParchment({ sceneId, entryId });
    game.socket.emit(CHANNEL, { type: "removeSceneParchment", sceneId, entryId });
}

/* -------------------------------------------------------------------------- */
/* Handlers (run on the GM client only)                                       */
/* -------------------------------------------------------------------------- */

const ARMOR_LOCS = ["head", "torso", "leftArm", "rightArm", "leftLeg", "rightLeg", "tailWing"];

/* Aggregate equipped armor into the per-location { sp, dr, itemIds } shape
 * the damage calculator expects. SP is the sum of every equipped piece's
 * {location}Stopping (no layering rules yet — simple stack). DR booleans
 * (bludgeoning / slashing / piercing) are unioned across pieces.
 *
 * Armor exposes per-location SP TWO ways: the raw `{loc}Stopping` field
 * on the base system, and the post-enhancement `system.effective.stopping`
 * map (computed by deriveArmorEffective). The effective map IS the truth
 * (it folds in socketed glyphs / mods) but the base fields are the
 * authoritative storage; we prefer effective.stopping when present and
 * fall back to the base field so a pre-effective item still soaks. */
function buildArmorShape(actor) {
    const armor = {};
    for (const item of actor.items ?? []) {
        if (item.type !== "armor" || !item.system?.equipped) continue;
        const eff = item.system?.effective ?? {};
        const sys = item.system;
        const drTypes = [];
        // DR booleans are exposed on effective; fall back to base.
        if (eff.bludgeoning ?? sys.bludgeoning) drTypes.push("bludgeoning");
        if (eff.slashing    ?? sys.slashing)    drTypes.push("slashing");
        if (eff.piercing    ?? sys.piercing)    drTypes.push("piercing");
        for (const loc of ARMOR_LOCS) {
            // effective.stopping[loc].value wins; base {loc}Stopping is the fallback.
            const sp = Number(eff.stopping?.[loc]?.value ?? sys[`${loc}Stopping`]) || 0;
            if (sp <= 0) continue;
            if (!armor[loc]) armor[loc] = { sp: 0, dr: [], itemIds: [] };
            armor[loc].sp += sp;
            armor[loc].itemIds.push(item.id);
            for (const t of drTypes) if (!armor[loc].dr.includes(t)) armor[loc].dr.push(t);
        }
    }
    return armor;
}

/* Scan for an Active Effect that represents the target's Active Shield —
 * marked by an `activeShieldHp` flag in the system namespace.  Returns
 * `{ hp, effectId }` so the handler can both feed the calculator AND
 * write the drained value back to the AE.  The flag-driven model lets
 * GMs apply / adjust shields by hand (token HUD, macros) without a
 * dedicated cast handler — RAW magic stays manual per earlier locked
 * decision; the calculator just respects whatever shield is on the
 * actor when an attack lands. */
function buildActiveShield(actor) {
    for (const ae of actor.effects ?? []) {
        if (ae.disabled) continue;
        const hp = Number(ae.getFlag?.(SYSTEM_ID, "activeShieldHp"));
        if (Number.isFinite(hp) && hp > 0) return { hp, effectId: ae.id };
    }
    return null;
}

/* For monsters: their SP is a single flat number on `combat.armor` that
 * applies to every location. Modeled as natural armor (separate from worn
 * armor so the bypassesNaturalArmor flag can target it).  No item-level
 * ablation (monster hides aren't items) — itemIds stays empty. */
function buildNaturalArmorShape(actor) {
    if (actor.type !== "monster") return {};
    const sp = Number(actor.system?.combat?.armor) || 0;
    if (sp <= 0) return {};
    const natural = {};
    for (const loc of ARMOR_LOCS) natural[loc] = { sp, dr: [], itemIds: [] };
    return natural;
}

/* Derive monster combat flags from the actor's authored data:
 *   resistNonSilver / resistNonMeteorite  ←  combat.weaponWeakness (silver|meteorite|none)
 *   vulnerableTo / resistTypes / immuneToTypes  ←  combat.damageProfile (per-type enum)
 *   immuneToOrganCrits  ←  category in {elementa, specter} (RAW Core p.159)
 * The two weapon-weakness flags are INDEPENDENT of the per-type lists —
 * a slashing-resistant monster that also takes half from non-silver
 * weapons quarters non-silver slashing hits and halves silver slashing
 * hits (the calculator stacks them multiplicatively). */
function buildMonsterFlags(actor) {
    if (actor.type !== "monster") return {};
    const sys      = actor.system ?? {};
    const profile  = sys.combat?.damageProfile ?? {};
    const weakness = sys.combat?.weaponWeakness ?? "none";
    /* Organ-crit immunity — explicit per-monster override on
     * system.combat.immuneToOrganCrits ("auto" | "true" | "false")
     * wins; "auto" falls back to category default (elementa / specter
     * are immune by default). */
    const overrideOrgan = sys.combat?.immuneToOrganCrits;
    const categoryOrgan = sys.category === "elementa" || sys.category === "specter";
    const flags = {
        resistNonSilver:    weakness === "silver",
        resistNonMeteorite: weakness === "meteorite",
        vulnerableTo:  [],
        resistTypes:   [],
        immuneToTypes: [],
        immuneToOrganCrits:
            overrideOrgan === "true"  ? true  :
            overrideOrgan === "false" ? false :
            categoryOrgan
    };
    for (const [type, reaction] of Object.entries(profile)) {
        if (reaction === "vulnerable") flags.vulnerableTo.push(type);
        else if (reaction === "resistant") flags.resistTypes.push(type);
        else if (reaction === "immune")    flags.immuneToTypes.push(type);
    }
    return flags;
}

/* Map an ATTACK_LOCATIONS key → the calculator's { key, mult, label } shape.
 * Falls back to a torso ×1 hit so unknown keys don't blow up the math. */
function resolveLocation(locationKey, locationLabel) {
    const entry = ATTACK_LOCATIONS[locationKey];
    if (!entry) return { key: "torso", mult: 1, label: locationLabel || "Torso" };
    return { key: locationKey, mult: entry.mult, label: locationLabel || locationKey };
}

/* Crit-bonus ladder per RAW Core p.158.  Normal targets get the standard
 * Simple +3 / Complex +5 / Difficult +8 / Deadly +10.  Elementa / specter
 * targets get the higher "Bonus Damage" table values (+5/+10/+15/+20)
 * because the organ-based wound effect doesn't apply to them — the
 * stronger flat bonus replaces it (Core p.159 sidebar). */
const CRIT_BONUS_NORMAL    = { simple: 3, complex: 5,  difficult: 8,  deadly: 10 };
const CRIT_BONUS_NO_ORGANS = { simple: 5, complex: 10, difficult: 15, deadly: 20 };
function critBonusFor(severity, immuneToOrganCrits) {
    if (!severity) return 0;
    const ladder = immuneToOrganCrits ? CRIT_BONUS_NO_ORGANS : CRIT_BONUS_NORMAL;
    return ladder[severity] ?? 0;
}

/* Translate the weapon's quality keys into the boolean flags the damage
 * calculator wants. Reads each quality's `damageFlags` config from the
 * active catalog (data-driven via the Qualities Editor) — adding or
 * retargeting a flag is a settings change, not a code edit. Status-rider
 * qualities fire in weaponAttackMixin AFTER damage applies. */
function qualitiesToDamageFlags(qualities = []) {
    const cat = getActiveWeaponQualities?.() ?? WEAPON_QUALITIES;
    const flags = {
        armorPiercing: false, improvedArmorPiercing: false, ablating: false,
        bypassesWornArmor: false, bypassesNaturalArmor: false, bypassesShield: false,
        isSilver: false, silverDamage: 0
    };
    for (const key of qualities) {
        const df = cat[key]?.damageFlags;
        if (!df) continue;
        for (const [flag, value] of Object.entries(df)) {
            if (value) flags[flag] = true;
        }
    }
    return flags;
}

async function handleApplyDamage(payload) {
    const target = await fromUuid(payload?.targetUuid);
    if (!target) return;

    // Backwards-compat: callers (chat macros, older buttons) may send
    // `amount` instead of `weaponDamage`, `type` (label) instead of
    // `damageTypes` (array), and `location` (label) instead of `locationKey`.
    const weaponDamage = Number(payload.weaponDamage ?? payload.amount);
    if (!Number.isFinite(weaponDamage)) return;

    const damageTypes = Array.isArray(payload.damageTypes)
        ? payload.damageTypes
        : (payload.type ? [String(payload.type).toLowerCase()] : []);

    const location = resolveLocation(payload.locationKey, payload.location ?? payload.locationLabel);
    const qualityFlags = qualitiesToDamageFlags(payload.qualities);

    // `throughArmor: true` is the legacy "raw damage to HP" shortcut. Map
    // it to full bypass so the calculator skips SP + DR + shield stages.
    const fullBypass = !!payload.throughArmor;

    // Build target shape first so we can read its monster flags to pick
    // the right crit-bonus ladder (elementa/specter get the higher one).
    const activeShield = buildActiveShield(target);
    const targetShape = {
        uuid:         target.uuid,
        hp:           { value: target.system.derivedStats?.hp?.value, temp: target.system.derivedStats?.hp?.temp },
        shield:       Number(target.system.derivedStats?.shield) || 0,
        armor:        buildArmorShape(target),
        naturalArmor: buildNaturalArmorShape(target),
        monsterFlags: buildMonsterFlags(target),
        activeEffects:{ activeShield: activeShield ? { hp: activeShield.hp } : null }
    };

    // Crit bonus: prefer an explicit numeric override (callers can still
    // pass it directly), else derive from severity using the right ladder.
    const critBonus = (Number.isFinite(Number(payload.critBonus)) && payload.critBonus !== undefined)
        ? Number(payload.critBonus)
        : critBonusFor(payload.critSeverity, targetShape.monsterFlags.immuneToOrganCrits);

    const damageSource = {
        kind:                  payload.kind ?? "weapon",
        weaponDamage,
        critBonus,
        damageTypes,
        location,
        defense:               Array.isArray(payload.defense) ? payload.defense : [],
        tangible:              payload.tangible !== false,
        isOngoingTick:         !!payload.isOngoingTick,
        bypassesWornArmor:     fullBypass || !!payload.bypassesWornArmor,
        bypassesNaturalArmor:  fullBypass || !!payload.bypassesNaturalArmor,
        bypassesShield:        fullBypass || !!payload.bypassesShield,
        ...qualityFlags
    };

    const result = resolveDamage({ damageSource, target: targetShape });

    /* Apply the patches. HP uses drainHp so the temp/value split is right. */
    const hpLoss = -result.patches.hp.delta;
    const updates = {};
    if (hpLoss > 0) {
        const { value, temp } = drainHp(target.system.derivedStats?.hp, hpLoss);
        updates["system.derivedStats.hp.value"] = value;
        updates["system.derivedStats.hp.temp"]  = temp;
    }
    if (result.patches.shield.delta) {
        const cur = Number(target.system.derivedStats?.shield) || 0;
        updates["system.derivedStats.shield"] = Math.max(0, cur + result.patches.shield.delta);
    }
    if (Object.keys(updates).length) await target.update(updates);

    /* Active Shield write-back — the calculator returns an hpDelta on the
     * AE pool; we update the flag with the new value, or delete the AE
     * entirely when the shield collapses (RAW: the spell ends and a
     * collapse rider fires, which the breakdown surfaces). */
    if (activeShield && result.patches.activeShield?.hpDelta) {
        const nextHp = Math.max(0, activeShield.hp + result.patches.activeShield.hpDelta);
        const ae = target.effects?.get?.(activeShield.effectId);
        if (ae) {
            if (nextHp <= 0) {
                try { await ae.delete(); } catch (err) { console.warn(`${SYSTEM_ID} | active shield delete failed`, err); }
            } else {
                try { await ae.setFlag(SYSTEM_ID, "activeShieldHp", nextHp); }
                catch (err) { console.warn(`${SYSTEM_ID} | active shield update failed`, err); }
            }
        }
    }

    /* SP ablation — write the new {location}Stopping value per armor item. */
    for (const { itemId, spDelta } of result.patches.armorAblation ?? []) {
        const armor = target.items?.get?.(itemId);
        if (!armor) continue;
        const locKey = damageSource.location.key;
        const field  = `${locKey}Stopping`;
        const cur    = Number(armor.system?.[field]) || 0;
        const next   = Math.max(0, cur + spDelta);
        if (next !== cur) await armor.update({ [`system.${field}`]: next });
    }

    /* Audit card — collapsed by default; lets the GM see exactly which
     * pipeline stages fired and the running totals. If the caller passed
     * `attackMessageUuid`, APPEND the breakdown to that message so the
     * whole attack lives in a single chat card; otherwise post standalone
     * (the fallback for non-attack damage sources, e.g. spell ticks). */
    try {
        const breakdownHtml = renderDamageBreakdown({
            targetName: target.name,
            result
        });
        const attackMsg = payload.attackMessageUuid ? await fromUuid(payload.attackMessageUuid) : null;
        if (attackMsg) {
            const fragment =
                `<div class="wdm-attack-applied">` +
                    `<div class="wdm-attack-applied-head">Applied to <strong>${escAttr(target.name)}</strong>: <span class="wdm-attack-applied-hp">${result.finalDamage > 0 ? `−${result.finalDamage} HP` : "no damage"}</span></div>` +
                    breakdownHtml +
                `</div>`;
            /* Typed summary chip — sits in the master one-liner with
             * a damage-red palette so the eye lands on it. Location
             * goes before damage so the chip reads "torso · 6 dmg". */
            const locLabel = location.label || location.key || "";
            const damageLabel = result.finalDamage > 0
                ? `${locLabel ? `${locLabel} · ` : ""}${result.finalDamage} dmg`
                : `${locLabel ? `${locLabel} · ` : ""}no damage`;
            await appendAttackResult(attackMsg, {
                fragment,
                summaryAdd: { label: damageLabel, kind: "damage", icon: "fa-burst" }
            });
        } else {
            await ChatMessage.create({
                speaker: ChatMessage.getSpeaker({ actor: target }),
                content: breakdownHtml,
                flags: { [SYSTEM_ID]: { category: "combat" } }
            });
        }
    } catch (err) {
        console.warn(`${SYSTEM_ID} | breakdown card render failed`, err);
    }

    /* Quality riders (bleeding, knockdown, fire, freeze, poison, stagger,
     * disease, entangling, stun). RAW: riders fire "on a damaging hit",
     * so gate on penetrated damage > 0 — armor that fully soaks the hit
     * means no rider. Single source of truth across all damage entry
     * points (button click, GM dock auto, scripted damage). */
    if (result.finalDamage > 0 && Array.isArray(payload.qualities) && payload.qualities.length) {
        try {
            await applyQualityRiders(
                target,
                payload.qualities,
                payload.qualityValues ?? {},
                location.key,
                ChatMessage.getSpeaker({ actor: target }),
                /* Pass the attack message uuid so the riders fold into
                 * the result block instead of posting standalone chat. */
                { attackMessageUuid: payload.attackMessageUuid ?? null }
            );
        } catch (err) {
            console.warn(`${SYSTEM_ID} | quality riders apply failed`, err);
        }
    }

    /* Critical wound auto-apply (Core p.158). The crit BONUS damage already
     * landed via the calculator's stage 7; here we also stamp the wound
     * itself onto the target (embedded item) and trigger its Stun save.
     * Only fires if a severity was determined upstream (delta ≥ 7). */
    if (payload.critSeverity) {
        try {
            await autoApplyCriticalWound({
                actor: target,
                severity: payload.critSeverity,
                locationKey: location.key,
                attackMessageUuid: payload.attackMessageUuid ?? null
            });
        } catch (err) {
            console.warn(`${SYSTEM_ID} | crit wound auto-apply failed`, err);
        }
    }

    return result;
}

/** Tiny attr-safe escape — protects against quotes/<> in actor names when
 *  we splice them into HTML being appended to the attack card. */
function escAttr(s) {
    return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

async function handleApplyStatus({ targetUuid, statusId, action }) {
    const target = await fromUuid(targetUuid);
    if (!target || !statusId) return;
    /* Validate the status ID up-front so a bad caller (typo in a quality
     * rider, malformed socket payload, scripted macro with an old id) just
     * logs and returns instead of crashing the damage application chain.
     * Foundry's toggleStatusEffect throws hard on unknown ids and that
     * propagated out of every `await emitApplyStatus` call site. */
    const known = (CONFIG.statusEffects ?? []).some(s => s.id === statusId);
    if (!known) {
        console.warn(`${SYSTEM_ID} | handleApplyStatus: unknown status id "${statusId}" — ignoring`);
        return;
    }
    const active = action !== "remove";
    /* Prefer the actor-level toggle — it works whether or not a token is
     * placed on the active scene. Falls back to the token API for legacy
     * callers that pass a token UUID. */
    try {
        if (typeof target.toggleStatusEffect === "function") {
            await target.toggleStatusEffect(statusId, { active });
            return;
        }
        const token = target.getActiveTokens?.()?.[0];
        const def   = CONFIG.statusEffects.find(s => s.id === statusId);
        if (token && def) await token.toggleEffect(def, { active });
    } catch (err) {
        console.warn(`${SYSTEM_ID} | handleApplyStatus failed for ${statusId}:`, err);
    }
}

/** GM-side: reduce a weapon/shield's Reliability by 1. Floored at 0.
 *  When it hits 0 the item is marked broken AND its `equipped` flag is
 *  flipped to false so it stops being a valid defense/attack pick on
 *  the dock / sheet / defense prompt. A chat notice goes out under the
 *  item owner's name so the table sees the breakage. */
async function handleReduceReliability({ itemUuid, attackMessageUuid = null }) {
    const item = await fromUuid(itemUuid);
    if (!item) {
        console.warn(`${SYSTEM_ID} | handleReduceReliability: item not found for uuid`, itemUuid);
        return;
    }
    const cur = Number(item.system?.reliability?.value) || 0;
    if (cur <= 0) return;       // already broken
    const next = Math.max(0, cur - 1);
    const broke = next === 0;
    const update = { "system.reliability.value": next };
    try {
        await item.update(update);
    } catch (err) {
        console.warn(`${SYSTEM_ID} | handleReduceReliability update failed:`, err);
        return;
    }
    const noticeHtml = `<div class="wdm-attack-rider"><i class="fa-solid fa-shield-halved"></i> <strong>${item.name}</strong> absorbs a block — SP <b>${cur}</b> → <b>${next}</b>${broke ? ` <strong style="color:#ff7a6b">(breaks!)</strong>` : ""}.</div>`;
    const attackMsg = attackMessageUuid ? await fromUuid(attackMessageUuid) : null;
    try {
        if (attackMsg) {
            /* Prefix with the defender's actor name so the summary
             * chip reads "Vlad's Steel Sword: broke" instead of
             * looking like the attacker's weapon. */
            const ownerName = item.actor?.name ? `${item.actor.name}'s ` : "";
            await appendAttackResult(attackMsg, {
                fragment: noticeHtml,
                summaryAdd: {
                    label: broke ? `${ownerName}${item.name} broke` : `${ownerName}${item.name} −1 SP`,
                    kind:  broke ? "fumble" : "status",
                    icon:  "fa-shield-halved"
                }
            });
        } else {
            await ChatMessage.create({
                speaker: ChatMessage.getSpeaker({ actor: item.actor }),
                content: noticeHtml,
                flags: { [SYSTEM_ID]: { category: "combat" } }
            });
        }
    } catch (err) {
        console.warn(`${SYSTEM_ID} | handleReduceReliability chat post failed:`, err);
    }
}

async function handleGrantIP({ actorUuid, label, value }) {
    const actor = await fromUuid(actorUuid);
    if (!actor) return;
    const log = [...(actor.system.logs?.ipLog ?? []), { label, value }];
    await actor.update({
        "system.improvementPoints": (actor.system.improvementPoints ?? 0) + value,
        "system.logs.ipLog": log
    });
}

async function handleGrantReputation({ actorUuid, delta }) {
    const actor = await fromUuid(actorUuid);
    if (!actor) return;
    const cur = actor.system.general?.reputation?.value ?? 0;
    await actor.update({ "system.general.reputation.value": cur + delta });
}

async function handleAddSceneParchment({ sceneId, entry }) {
    const scene = game.scenes.get(sceneId);
    if (!scene || !entry) return;
    const list = foundry.utils.duplicate(scene.getFlag(SYSTEM_ID, PARCHMENT_FLAG) || []);
    list.push(entry);
    await scene.setFlag(SYSTEM_ID, PARCHMENT_FLAG, list);
}

async function handleRemoveSceneParchment({ sceneId, entryId }) {
    const scene = game.scenes.get(sceneId);
    if (!scene) return;
    const list = foundry.utils.duplicate(scene.getFlag(SYSTEM_ID, PARCHMENT_FLAG) || []);
    await scene.setFlag(SYSTEM_ID, PARCHMENT_FLAG, list.filter(n => n.id !== entryId));
}

/* -------------------------------------------------------------------------- */
/* Defense pre-roll prompt — cross-client request/response                    */
/* -------------------------------------------------------------------------- */

/* Pending requests on the ATTACKER's client, keyed by requestId. Resolved
 * when the matching defenseResponse comes back, or by timeout. */
const _pendingDefenseRequests = new Map();

/* Pick which user should be prompted for a given defender actor. Active
 * player owner first (the actor's actual player). Falls back to the active
 * GM when no player owner is online. Returns null if no one's connected. */
function pickDefenderOwner(actor) {
    if (!actor) return null;
    const players = (game.users?.players ?? [])
        .filter(u => u.active && actor.testUserPermission?.(u, "OWNER"));
    if (players.length) return players[0];
    return game.users?.activeGM ?? null;
}

/* Attacker-side entry point: ask the defender's owner what defense to use.
 * Resolves to { action, itemId?, timedOut? } once they answer or the
 * timeout fires. If the defender has no online owner OR the attacker IS
 * the defender's owner, the prompt opens locally instead. */
export async function requestDefenseFromOwner({
    defenderActor, attackerName, weaponName, weaponImg, engagementId = "", timeoutMs = 30000,
    attackKind = "normal", shotIndex = 1, totalShots = 1, disallowedItemIds = []
}) {
    if (!defenderActor) return { action: "none" };

    const owner = pickDefenderOwner(defenderActor);
    /* No active recipient OR we ARE the defender's owner → open the prompt
     * locally, run the defender's actions inline, and resolve directly.
     * The defender's defendWith / defendBySkill calls carry `engagementId`
     * so the resulting defense chat card stamps the linkage flag (used by
     * the attacker's damage button for crit detection). */
    if (!owner || owner.id === game.user?.id) {
        const { openDefensePrompt } = await import("../applications/defensePromptDialog.mjs");
        const choice = await openDefensePrompt({
            attackerName, weaponName, weaponImg, defenderActor, timeoutMs,
            attackKind, shotIndex, totalShots, disallowedItemIds
        });
        const packet = await runDefenseChoice(defenderActor, choice, engagementId);
        return { ...choice, ...packet };
    }

    const requestId = `def-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            _pendingDefenseRequests.delete(requestId);
            resolve({ action: "none", timedOut: true });
        }, timeoutMs + 2000);          // a touch longer than the dialog's own timeout
        _pendingDefenseRequests.set(requestId, { resolve, timer });
        game.socket.emit(CHANNEL, {
            type: "defenseRequest",
            recipientUserId: owner.id,
            senderUserId: game.user?.id,
            requestId,
            engagementId,
            attackerName, weaponName, weaponImg,
            attackKind, shotIndex, totalShots, disallowedItemIds,
            defenderUuid: defenderActor.uuid,
            timeoutMs
        });
    });
}

/* Run a defender's chosen reaction (defendWith / defendBySkill).  When
 * engagement-linked the underlying roll SUPPRESSES its own chat card —
 * we bubble back the roll total + rendered HTML so the attacker's flow
 * can fold the defense into the unified attack chat card.
 *
 * Returns { defenseTotal, defenseFlavor, defenseBody } or nulls when
 * no roll happened (action "none" / no eligible item / unknown action). */
async function runDefenseChoice(defenderActor, choice, engagementId) {
    const empty = { defenseTotal: null, defenseFlavor: "", defenseBody: "" };
    const pick = (r) => Number.isFinite(r?.defenseTotal)
        ? { defenseTotal: r.defenseTotal, defenseFlavor: r.defenseFlavor ?? "", defenseBody: r.defenseBody ?? "" }
        : empty;
    try {
        if (choice.action === "parry" || choice.action === "block") {
            const item = defenderActor.items?.get?.(choice.itemId);
            if (item && typeof defenderActor.defendWith === "function") {
                return pick(await defenderActor.defendWith(item, choice.action, { engagementId }));
            }
            console.warn(`${SYSTEM_ID} | defense prompt: ${choice.action} chosen but no eligible item`);
        } else if (choice.action === "dodge") {
            if (typeof defenderActor.defendBySkill === "function") {
                return pick(await defenderActor.defendBySkill("dodge", { label: "Dodge", engagementId }));
            }
        } else if (choice.action === "reposition") {
            if (typeof defenderActor.defendBySkill === "function") {
                return pick(await defenderActor.defendBySkill("athletics", { label: "Reposition", engagementId, reposition: true }));
            }
        }
    } catch (err) {
        console.warn(`${SYSTEM_ID} | runDefenseChoice failed`, err);
    }
    return empty;
}

/* Defender-side handler: open the prompt and ship the answer back. */
async function handleDefenseRequest(data) {
    try {
        const { openDefensePrompt } = await import("../applications/defensePromptDialog.mjs");
        const defenderActor = await fromUuid(data.defenderUuid);
        if (!defenderActor) {
            game.socket.emit(CHANNEL, {
                type: "defenseResponse",
                recipientUserId: data.senderUserId,
                requestId: data.requestId,
                action: "none",
                error: "defender not found"
            });
            return;
        }
        const choice = await openDefensePrompt({
            attackerName: data.attackerName,
            weaponName:   data.weaponName,
            weaponImg:    data.weaponImg,
            defenderActor,
            timeoutMs:    data.timeoutMs ?? 30000,
            attackKind:        data.attackKind        ?? "normal",
            shotIndex:         data.shotIndex         ?? 1,
            totalShots:        data.totalShots        ?? 1,
            disallowedItemIds: Array.isArray(data.disallowedItemIds) ? data.disallowedItemIds : []
        });
        /* Fire the defender's actual defense roll on this client (the
         * defender's owner) so the result posts to chat as their own card,
         * stamped with the engagement flag for crit detection.
         *   parry / block → defendWith(item, mode) on a weapon/shield
         *   dodge         → defendBySkill("dodge")          (same as the dock's Dodge button)
         *   reposition      → defendBySkill("athletics", …)   (same as the dock's Reposition button)
         *
         * Roll FIRST then send the response so the attacker's verdict can
         * use the live defenseTotal in the unified chat card. */
        const packet = await runDefenseChoice(defenderActor, choice, data.engagementId ?? "");
        game.socket.emit(CHANNEL, {
            type: "defenseResponse",
            recipientUserId: data.senderUserId,
            requestId: data.requestId,
            action:    choice.action ?? "none",
            itemId:    choice.itemId ?? null,
            timedOut:  !!choice.timedOut,
            defenseTotal:  packet.defenseTotal,
            defenseFlavor: packet.defenseFlavor,
            defenseBody:   packet.defenseBody
        });
    } catch (err) {
        console.warn(`${SYSTEM_ID} | handleDefenseRequest failed`, err);
    }
}

/* Attacker-side: receive the defender's reply, resolve the pending Promise. */
function handleDefenseResponse(data) {
    const pending = _pendingDefenseRequests.get(data.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    _pendingDefenseRequests.delete(data.requestId);
    pending.resolve({
        action:        data.action ?? "none",
        itemId:        data.itemId ?? null,
        timedOut:      !!data.timedOut,
        defenseTotal:  Number.isFinite(Number(data.defenseTotal)) ? Number(data.defenseTotal) : null,
        defenseFlavor: data.defenseFlavor ?? "",
        defenseBody:   data.defenseBody   ?? ""
    });
}
