/**
 * brawlMixin — actor method for unarmed / brawling combat.
 *
 * Composed onto WitcherActor (documents/actor.mjs). Exposes:
 *   actor.brawlAttack(options)   — open the brawl dialog and resolve the action
 *
 * Fired by the combat dock's Brawl button. Covers the full Fist-Fighting +
 * grappling list (Core p.159-160): punch / kick (with strong/fast strikes and
 * called shots), push kick, charge, disarm, and the grapple chain
 * (grapple / pin / choke / throw / trip). Block is the defensive use — it rolls
 * Brawling as a defense and records a defensive action.
 *
 * Brawling rolls REF + Brawling to hit and deals NON-LETHAL damage from the
 * actor's derived Punch/Kick formula. Grapple riders are LIGHT-mechanized: the
 * roll is posted, the relevant status (grappled/pinned/prone/suffocation) is
 * applied to the user's target where possible, and the opposed Dodge/Escape
 * contest is left to the GM (described on the card).
 *
 * Returns { declaration, kind } so the dock can route the action economy
 * (attacks spend an action slot; a block records a defense), or null on cancel.
 */

import { extendedRoll } from "../../rolls/extendedRoll.mjs";
import { critSeverityFromDelta } from "../../combat/critSeverity.mjs";
import { hrCritBrackets } from "../../mechanics/house-rules-config.mjs";
import { contextualPhysicalMod, contextualPhysicalChip, holdTargetBlockReason, isPinned, isHeldByFoe } from "../../mechanics/holdModifiers.mjs";
import { openBrawlDialog } from "../../applications/brawlDialog.mjs";
import { ATTACK_LOCATIONS, rollHitLocation, getActiveWeaponQualities, WEAPON_QUALITIES } from "../../setup/config.mjs";
import { requestDefenseFromOwner, emitApplyStatus, emitPushToken, emitApplyDamage } from "../../setup/socketHook.mjs";
import { applyHoldLink, getHoldLinks, HOLD_STATUSES, normalizedActorUuid, areActorsAdjacent } from "../../mechanics/holdLink.mjs";
import { attackMod as statusAttackMod, clauseFor as _clauseFor } from "../../mechanics/statusEngine.mjs";
import { isCombatExtendedEnabled } from "../../api/homebrew.mjs";

import { t, tFormat } from "../../chrome/lib/i18n.js";
/** Damage formula contributions from equipped weapons whose qualities
 *  declare `addsDamageToUnarmed` (the Brawling quality on a cestus / spiked
 *  gauntlet — Core p.165). Returns an array of `{ name, formula }`; the
 *  caller concatenates them into the unarmed strike's damage with `+`.
 *  Reads the active catalog so a GM-authored quality with the same flag
 *  works the same way.
 *
 *  Two sources are scanned in order:
 *    1. `actor.items` — equipped weapon items (the PC path).
 *    2. `actor.system.combat.attacks` — monster inline attacks (the monster
 *       path). Monsters don't carry item weapons by default, so without the
 *       second scan a monster Brawl swing would never fold in a Brawling-
 *       quality inline attack. */
function brawlingWeaponBonuses(actor) {
    const cat = getActiveWeaponQualities?.() ?? WEAPON_QUALITIES;
    const out = [];
    for (const w of actor?.items ?? []) {
        if (w.type !== "weapon" || !w.system?.equipped) continue;
        const qs = w.system?.effective?.qualities ?? w.system?.qualities ?? [];
        if (!qs.some(q => cat[q]?.addsDamageToUnarmed)) continue;
        const dmg = String(w.system?.effective?.damage ?? w.system?.damage ?? "").trim();
        if (!dmg) continue;
        out.push({ name: w.name, formula: dmg });
    }
    if (actor?.type === "monster") {
        const attacks = Array.isArray(actor.system?.combat?.attacks) ? actor.system.combat.attacks : [];
        for (const a of attacks) {
            const qs = Array.isArray(a?.qualities) ? a.qualities : [];
            if (!qs.some(q => cat[q]?.addsDamageToUnarmed)) continue;
            const dmg = String(a?.damage ?? "").trim();
            if (!dmg) continue;
            out.push({ name: String(a?.name || t("WITCHER.Doc.BrawlMixin.Text.Attack", "Attack")), formula: dmg });
        }
    }
    return out;
}

const esc    = (s) => Handlebars.escapeExpression(String(s ?? ""));
const signed = (n) => `${n >= 0 ? "+" : ""}${n}`;
const L      = (k) => game.i18n.localize(k);

/** Localize a stat label, falling back to the upper-cased key. */
function statName(statKey) {
    const key = String(statKey ?? "").toLowerCase();
    const out = game.i18n.localize(CONFIG.WITCHER.statLabel(key));
    return (!out || out.startsWith("WITCHER.")) ? key.toUpperCase() : out;
}

/** Build the unarmed damage display + rollable formula from the actor's derived
 *  Punch/Kick. Honours the strike multiplier (strong ×2) and the half-damage
 *  push kick. Folds in any Brawling-quality weapon damage from equipped
 *  items (cestus, spiked gauntlet, etc. — Core p.165). Returns empty
 *  strings for actions that deal no damage. */
/* Natural Weapons (race) — when the actor owns a race with Natural Weapons
 * enabled, its damage code REPLACES the core unarmed dice (the 1d6 in
 * punch/kick), and carries a damage type, lethal flag, and qualities that ride
 * the unarmed strike. Melee Bonus still adds; kick still adds +4. */
function naturalWeaponConfig(actor) {
    const race = (actor?.items ?? []).find(i => i.type === "race" && i.system?.naturalWeapons);
    if (!race) return null;
    const s = race.system ?? {};
    const types = Array.isArray(s.naturalWeaponTypes) && s.naturalWeaponTypes.length
        ? s.naturalWeaponTypes.filter(Boolean)
        : (s.naturalWeaponType ? [String(s.naturalWeaponType)] : ["bludgeoning"]);
    return {
        damage:        String(s.naturalWeaponDamage ?? "").trim() || "1d6",
        lethal:        !!s.naturalWeaponLethal,
        canParry:      !!s.naturalWeaponCanParry,
        canBlock:      !!s.naturalWeaponCanBlock,
        name:          race.name || "",
        types,
        qualities:     Array.isArray(s.naturalWeaponQualities) ? s.naturalWeaponQualities : [],
        qualityValues: s.naturalWeaponQualityValues ?? {}
    };
}

function brawlDamage(actor, meta, strikeMeta) {
    if (!meta.damage) return { display: "", formula: "" };
    const ds = actor.system?.derivedStats ?? {};
    /* Rebuild punch/kick from the CURRENT meleeBonus rather than reading
     * ds.punch / ds.kick, which are frozen strings baked at
     * prepareDerivedData time from the pre-AE meleeBonus. Foundry applies
     * AE changes targeting `system.derivedStats.meleeBonus` in the FINAL
     * phase, AFTER prepareDerivedData — so the stored punch/kick strings
     * miss any AE contribution (mutagens, Primal Reservoir, gear procs).
     * Weapon damage reads meleeBonus live at roll time (weaponAttackMixin
     * damageFor) so it saw the AE; brawling didn't. RAW punch = 1d6 + MB,
     * kick = 1d6 + MB + 4 (Core p.48). */
    const mb = Number(ds.meleeBonus) || 0;
    // Natural Weapons replace the core 1d6; MeleeBonus still adds, kick still +4.
    const nw   = naturalWeaponConfig(actor);
    const core = nw ? nw.damage : "1d6";
    const flat = mb + (meta.damage === "kick" ? 4 : 0);
    const base = flat ? `${core}${flat > 0 ? "+" : ""}${flat}` : core;
    if (!base) return { display: "", formula: "" };

    // Brawling-quality weapons (cestus, spiked gauntlet, etc.) add their
    // damage to the unarmed strike. Strikes that deal HALF or ×N damage
    // multiply the combined total — that's what the description says, and
    // it matches the way critBonus rides through the existing pipeline.
    const bonuses = brawlingWeaponBonuses(actor);
    const baseExpr = bonuses.length
        ? `${base} + ${bonuses.map(b => b.formula).join(" + ")}`
        : base;
    const bonusLabel = bonuses.length
        ? ` + ${bonuses.map(b => b.name).join(" + ")}`
        : "";

    if (meta.half) return { display: `½ (${baseExpr})${bonusLabel}`, formula: `floor((${baseExpr})/2)` };
    const mult = strikeMeta?.dmgMult ?? 1;
    if (mult !== 1) return { display: `(${baseExpr})${bonusLabel} ×${mult}`, formula: `(${baseExpr})*${mult}` };
    return { display: `${baseExpr}${bonusLabel}`, formula: baseExpr };
}

/** True when `attacker` is currently in a hold pair with `target` of any
 *  kind. Used to gate `needsGrapple` actions (pin / choke / throw / trip)
 *  which RAW says require an active grapple with the intended target —
 *  not just "actor is grappling someone somewhere".
 *
 *  Normalizes the target's uuid the same way the registry does on write.
 *  Without this, an unlinked NPC token — whose `.uuid` is the synthetic
 *  `Scene.X.Token.Y.Actor.Z` form — never matches the stored world-uuid
 *  (`Actor.Z`) partnerUuid, so the follow-up Pin / Choke / Throw refused
 *  even though the grapple had landed. */
async function attackerHoldsTarget(attacker, target) {
    if (!attacker || !target) return false;
    const pairs = await getHoldLinks(attacker);
    const targetUuid = normalizedActorUuid(target);
    return pairs.some(p => p?.partnerUuid === targetUuid);
}

/** Apply a status to a single target actor. Hold-family statuses go
 *  through applyHoldLink so the pair-based bookkeeping + adjacency
 *  check fire. Every other status routes through emitApplyStatus,
 *  which the GM-side socket handler applies with GM permissions —
 *  necessary because `Actor#toggleStatusEffect` refuses when the
 *  caller isn't an owner of the target actor (a player attacking an
 *  NPC never owns the NPC, so a direct toggle silently failed and
 *  the status never landed). Returns true on best-effort success. */
async function applyStatusToTarget(attacker, target, statusId) {
    if (!statusId || !target) return false;
    try {
        if (HOLD_STATUSES.includes(statusId)) {
            return !!(await applyHoldLink(attacker, target, statusId));
        }
        if (target.uuid) {
            /* GM-routed apply. Returns synchronously true because the
             * socket dispatch is fire-and-forget — the GM's handler
             * confirms + toggles. Best-effort per the rest of the
             * pipeline; a failure surfaces in the console but not in
             * the return value. */
            emitApplyStatus({ targetUuid: target.uuid, statusId, action: "apply", sourceActorUuid: attacker?.uuid });
            return true;
        }
        /* Fallback for a target with no uuid (unusual — synthetic actor
         * used inline). Try the direct toggle, which may still fail on
         * ownership but at least attempts something. */
        await target.toggleStatusEffect?.(statusId, { active: true });
        return true;
    } catch (err) {
        console.warn("witcher-ttrpg-death-march | brawl status apply failed", err);
        return false;
    }
}

/** The brawl chat-card header — actor + action, a chip row, optional damage
 *  line (with the wdm-roll-damage button the global handler wires) and a note. */
function brawlFlavor({ actorName, actionName, subtitle, chips = [], damage, note = "" }) {
    const chipHtml = chips
        .filter(c => c && c.value != null && c.value !== "")
        .map(c => `<span class="wdm-chip"><span class="wdm-chip-k">${esc(c.label)}</span><span class="wdm-chip-v">${esc(c.value)}</span></span>`)
        .join("");
    const locMult = Number(damage?.locMult) || 1;
    const locNote = (damage?.display && locMult !== 1)
        ? `<div class="wdm-attack-damage-note">${esc(L("WITCHER.Attack.SubtractSP"))} ×${esc(locMult)}${damage.locLabel ? ` (${esc(damage.locLabel)})` : ""}</div>`
        : "";
    const damageHtml = damage?.display ? `
        <div class="wdm-attack-damage">
            <span class="wdm-attack-damage-k">${esc(L("WITCHER.Attack.Damage"))}</span>
            <span class="wdm-attack-damage-v">${esc(damage.display)}</span>
            ${damage.formula ? `<button type="button" class="wdm-attack-damage-roll" data-action="wdm-roll-damage" data-formula="${esc(damage.formula)}" data-types="${esc(damage.types ?? "")}"${Array.isArray(damage.typeKeys) && damage.typeKeys.length ? ` data-type-keys="${esc(JSON.stringify(damage.typeKeys))}"` : ""} data-loc-mult="${esc(locMult)}" data-loc-label="${esc(damage.locLabel ?? "")}"${damage.locKey ? ` data-loc-key="${esc(damage.locKey)}"` : ""}${damage.nonLethal ? ` data-non-lethal="1"` : ""}${Array.isArray(damage.qualities) && damage.qualities.length ? ` data-qualities="${esc(JSON.stringify(damage.qualities))}" data-quality-values="${esc(JSON.stringify(damage.qualityValues ?? {}))}"` : ""}><i class="fa-solid fa-burst"></i> ${esc(L("WITCHER.Attack.RollDamage"))}</button>` : ""}
        </div>${locNote}` : "";
    const noteHtml = note
        ? `<div class="wdm-attack-note"><i class="fa-solid fa-circle-info"></i> ${note}</div>`
        : "";
    return `
        <div class="wdm-skill-head wdm-attack-head">
            <div class="wdm-skill-actor">${esc(actorName)}</div>
            <div class="wdm-skill-name">${esc(actionName)}</div>
            ${subtitle ? `<div class="wdm-skill-sub">${esc(subtitle)}</div>` : ""}
            ${chipHtml ? `<div class="wdm-skill-chips">${chipHtml}</div>` : ""}
            ${damageHtml}
            ${noteHtml}
        </div>`;
}

export const brawlMixin = (Base) => class extends Base {

    /**
     * Open the brawl dialog and resolve the chosen unarmed action.
     * @param {object} options  reserved for future callers
     * @returns {Promise<{declaration:object, kind:string}|null>}
     */
    async brawlAttack(options = {}) {
        const sv = this._readSkillValues("brawling");
        if (!sv) return null;
        /* Pinner lock: while pinning someone you're committed to them — you
         * can only act against the foe you pin. Refuse a brawl attack aimed at
         * anyone else (escape/reverse use their own fast paths, no forceDefender
         * — a pinner isn't held, so they don't hit this). */
        if (options.forceDefender && holdTargetBlockReason(this, options.forceDefender) === "pinning") {
            ui.notifications?.warn(tFormat("WITCHER.Doc.BrawlMixin.Notify.PinnerLocked", { name: this.name }, "{name} is pinning someone — they can only act against the pinned foe."));
            return null;
        }
        /* Pinned grapplee lock: while pinned you can act ONLY against the foe
         * holding you (Escape / Reverse — both routed at the target you picked).
         * Refuse a brawl aimed at anyone else. Escape/Reverse fast paths carry
         * no forceDefender and skip this; the dialog further limits a pinned
         * actor to Escape/Reverse via the action-slot lock. Registry-based so an
         * unlinked token's pinned status still counts. */
        if (options.forceDefender && !options.escape && !options.reverseGrapple
            && isPinned(this) && !isHeldByFoe(this, options.forceDefender)) {
            ui.notifications?.warn(tFormat("WITCHER.Doc.BrawlMixin.Notify.PinnedLocked", { name: this.name }, "{name} is pinned — they can only act against the foe holding them."));
            return null;
        }
        const baseChips = [
            { label: statName(sv.meta.statKey), value: sv.statVal },
            { label: t("WITCHER.Common.Rank", "Rank"), value: sv.skillVal },
            sv.skillMod ? { label: t("WITCHER.Common.Mod", "Mod"), value: signed(sv.skillMod) } : null
        ].filter(Boolean);

        /* Charging status — set by the dock's Full Round → Charge
         * action. The brawl dialog filter restricts the picker to
         * the Charge action ONLY when set. Post-dialog we strip the
         * status. Applies here for the strip; the picker restriction
         * lives in the dialog itself. */
        const _wasCharging = !!this.statuses?.has?.("charging");

        /* Fast path — `escape: true` skips the brawl dialog entirely and
         * jumps straight to the Escape flow. Used by the dock's Action
         * menu when the actor is already in a hold pair: the player
         * clicked "Escape (Dodge/Escape vs Brawling)" and doesn't need
         * to pick a brawl action from the picker. Falls back through
         * the isEscape branch below with a synthetic declaration.
         *
         * Same shape supports `reverseGrapple: true` — a CE Combat
         * Extended dominance-swap for actors currently grappled but not
         * pinned/choked. */
        let decl;
        if (options.escape) {
            const { BRAWL_ACTIONS } = await import("../../setup/config.mjs");
            const meta = BRAWL_ACTIONS.escape;
            if (!meta) return null;
            decl = {
                action: "escape", actionMeta: meta,
                strike: "normal", strikeMeta: {},
                grandMod: sv.total, chips: baseChips,
                location: { mode: "random", kind: "human", penalty: 0, mult: null }
            };
        } else if (options.reverseGrapple) {
            const { BRAWL_ACTIONS } = await import("../../setup/config.mjs");
            const meta = BRAWL_ACTIONS.reverseGrapple;
            if (!meta) return null;
            decl = {
                action: "reverseGrapple", actionMeta: meta,
                strike: "normal", strikeMeta: {},
                grandMod: sv.total, chips: baseChips,
                location: { mode: "random", kind: "human", penalty: 0, mult: null }
            };
        } else {
            /* If a natural weapon defines more than one damage type, offer a
             * per-type picker in the dialog (mirrors a multi-type weapon). The
             * dialog returns decl.damageTypes; brawlDamage falls back to all
             * configured types when the picker is absent/empty. */
            const _nwCfg = naturalWeaponConfig(this);
            const _nwTypes = (_nwCfg && _nwCfg.types.length > 1) ? _nwCfg.types : [];
            decl = await openBrawlDialog(this, { base: { total: sv.total, chips: baseChips }, naturalWeaponTypes: _nwTypes, targetActor: options.forceDefender ?? null });
            if (!decl) return null;
        }
        /* Strip the charging status now that the strike is committed. */
        if (_wasCharging) {
            try { await this.toggleStatusEffect?.("charging", { active: false }); }
            catch (_) { /* best-effort */ }
        }

        let meta = decl.actionMeta;
        /* strikeMeta likewise — CE Trip enhancement mutates dmgMult so
         * we need a mutable local copy. */
        let strikeMeta = decl.strikeMeta ?? {};
        const speaker = ChatMessage.getSpeaker({ actor: this });

        // Block — a defensive Brawling roll. No damage, no target status; the
        // dock records the defensive action.
        if (meta.kind === "defense") {
            await this.rollSkill("brawling");
            return { declaration: decl, kind: "defense" };
        }

        /* CE Reverse Grapple — dominance swap. The reverser must be
         * currently GRAPPLED but not pinned or choked. Opposed
         * Brawling vs the current holder. On win, the pair record's
         * holder/target swap; visible statuses migrate; a chat card
         * announces the flip. */
        if (meta.isReverseGrapple) {
            const pairs = await getHoldLinks(this);
            /* Reverse acts on the TOP layer of the hold ON you: a pin reverses
             * the pin (and inherits the underlying grapple — handled in
             * _doReverseHold, which swaps the whole stack); a plain grapple
             * reverses the grapple. A chokehold can't be reversed — it must be
             * escaped first (you're suffocating, not wrestling for position). */
            const pinnedPair = pairs.find(p => p.kind === "pinned"  && p.role === "target");
            const grappledPair = pairs.find(p => p.kind === "grappled" && p.role === "target");
            const chokedPair = pairs.find(p => p.kind === "chokeheld" && p.role === "target");
            const topPair = pinnedPair ?? grappledPair;
            if (!topPair) {
                ui.notifications?.warn(tFormat("WITCHER.Doc.BrawlMixin.Notify.NotGrappledReverse", { actor: this.name }, "{actor} isn't currently grappled — nothing to reverse."));
                return null;
            }
            if (chokedPair && !pinnedPair) {
                /* Choked but not pinned — choke has to be broken with Escape. */
                ui.notifications?.warn(tFormat("WITCHER.Doc.BrawlMixin.Notify.XCanOnlyReverseAPlain", { this: this.name }, "{this} can only reverse a grapple or pin — a chokehold has to be broken with Escape first."));
                return null;
            }
            const reverseKind = topPair.kind;   // "pinned" or "grappled"
            const holder = await fromUuid(topPair.partnerUuid).catch(() => null);
            if (!holder) {
                ui.notifications?.warn(tFormat("WITCHER.Doc.BrawlMixin.Notify.GrapplerUnresolved", { actor: this.name }, "{actor}'s grappler couldn't be resolved — try again after a token refresh."));
                return null;
            }
            /* The reverser IS the grapplee, so their -2 (grappled) applies to
             * this roll like any other physical action — no carve-out for the
             * grapplee. (Only the GRAPPLER waives their penalty, toward the
             * grapplee.) */
            const reverserRoll = await this.rollSkill("brawling", { silent: false });
            const reverserTotal = Number(reverserRoll?.total) || 0;
            /* The holder now gets a REAL defense choice — Brawling or
             * Dodge/Escape (plus their own Grappling weapon if they have one),
             * per the reverse gate (DEFENSE_GATE.reverseGrapple) — instead of an
             * auto-rolled flat Brawling. Same opposed-fold as the grapple flow:
             * "none"/timeout → DC 10. */
            let holderChoice = null;
            try {
                holderChoice = await requestDefenseFromOwner({
                    defenderActor: holder,
                    attackerName:  this.name,
                    weaponName:    L(meta.labelKey),
                    weaponImg:     "",
                    engagementId:  `reverse-${Date.now()}-${Math.random().toString(36).slice(2)}`,
                    attackKind:    "reverseGrapple",
                    attackerUuid:  this.uuid
                });
            } catch (err) {
                console.warn("witcher-ttrpg-death-march | reverse defense request failed", err);
                holderChoice = { action: "none" };
            }
            if (holderChoice && (holderChoice.action === "none" || holderChoice.timedOut === true)) {
                holderChoice.defenseTotal = 10;
                holderChoice._dc10Pass = true;
            }
            const holderTotal = Number(holderChoice?.defenseTotal) || 0;
            /* Human label for what the holder actually did (weapon name /
             * Brawling / Dodge-Escape / no-defense), for the chat card. */
            const holderDefLabel = holderChoice?._dc10Pass
                ? t("WITCHER.Doc.BrawlMixin.Text.NoDefenseDC10", "no defense — DC 10")
                : holderChoice?.action === "dodge"
                    ? t("WITCHER.Common.Dodge", "Dodge")
                    : holderChoice?.action === "brawlBlock"
                        ? (holderChoice.itemId
                            ? (holder.items?.get?.(holderChoice.itemId)?.name ?? t("WITCHER.Common.Brawling", "Brawling"))
                            : t("WITCHER.Common.Brawling", "Brawling"))
                        : (holderChoice?.action ?? t("WITCHER.Doc.BrawlMixin.Text.Defense", "Defense"));
            const won = reverserTotal > holderTotal;
            if (won) {
                const { reverseHold } = await import("../../mechanics/holdLink.mjs");
                await reverseHold(this, holder, reverseKind);   // top layer: pin swaps the whole stack
            }
            const verdict = won
                ? `<div style="color:#4a4">${tFormat("WITCHER.Doc.BrawlMixin.Text.ReverseGrappleWon", { name: esc(this.name), holder: esc(holder.name) }, `<b>${esc(this.name)}</b> wrestles the dominant position — <b>${esc(holder.name)}</b> is now the one grappled.`)}</div>`
                : `<div style="color:#a44">${tFormat("WITCHER.Doc.BrawlMixin.Text.ReverseGrappleLost", { name: esc(this.name), holder: esc(holder.name) }, `<b>${esc(this.name)}</b> can't turn the tables — <b>${esc(holder.name)}</b> keeps the hold.`)}</div>`;
            /* Holder's defense breakdown chips (stat/skill/status + any hold
             * penalty) so the table sees exactly what the defender rolled. */
            const holderChipRow = (Array.isArray(holderChoice?.defenseChips) && holderChoice.defenseChips.length)
                ? `<div class="wdm-attack-defense-chips" style="display:flex;flex-wrap:wrap;gap:3px;margin-top:3px;">${
                    holderChoice.defenseChips.filter(c => c && c.value != null && c.value !== "")
                        .map(c => `<span class="wdm-chip wdm-chip-def"><span class="wdm-chip-k">${esc(c.label)}</span><span class="wdm-chip-v">${esc(c.value)}</span></span>`).join("")
                }</div>`
                : "";
            await ChatMessage.create({
                speaker,
                content:
                    `<div class="wdm-attack-card">` +
                        tFormat("WITCHER.Doc.BrawlMixin.Text.ReverseGrappleHeader2", { name: esc(this.name), reverser: reverserTotal, holder: esc(holder.name), def: esc(holderDefLabel), holderTotal }, `<b>${esc(this.name)}</b> — Reverse Grapple: <b>${reverserTotal}</b> vs <b>${esc(holder.name)}</b>'s ${esc(holderDefLabel)} <b>${holderTotal}</b>.`) +
                        holderChipRow +
                        verdict +
                    `</div>`
            });
            return {
                declaration: decl, kind: "reverseGrapple",
                reverserTotal, holderTotal, won
            };
        }

        /* Release Grapple — voluntary end of every hold this actor
         * currently MAINTAINS as the holder. No opposed roll — a grappler
         * can let go whenever. Clears each holder-side pair with a
         * targeted clearHoldLink call (never a cascade, which would also
         * clear pairs where this actor is the TARGET — a grappler
         * releasing their grip on victim A shouldn't also free themselves
         * from victim B's counter-grapple on them). */
        if (meta.isReleaseGrapple) {
            const pairs = await getHoldLinks(this);
            const holderPairs = pairs.filter(p => p.role === "holder");
            if (!holderPairs.length) {
                ui.notifications?.warn(tFormat("WITCHER.Doc.BrawlMixin.Notify.NotHolding", { actor: this.name }, "{actor} isn't holding anyone — nothing to release."));
                return null;
            }
            const { clearHoldLink } = await import("../../mechanics/holdLink.mjs");
            const releasedNames = [];
            for (const p of holderPairs) {
                /* A grapple release does NOT break the clinch — grapple and
                 * clinch are separate layers (grappling auto-establishes a
                 * clinch). Releasing lets go of the wrestling holds
                 * (grappled / pinned / chokeheld) but leaves the chest-to-
                 * chest clinch standing; break that separately. Kind-scoped
                 * clear (not a cascade) so only THIS layer with THIS partner
                 * drops. */
                if (p.kind === "clinched") continue;
                const partner = await fromUuid(p.partnerUuid).catch(() => null);
                if (!partner) continue;
                const ok = await clearHoldLink(this, "voluntary release", partner, p.kind);
                if (ok && !releasedNames.includes(partner.name)) releasedNames.push(partner.name);
            }
            const list = releasedNames.length
                ? releasedNames.join(", ")
                : t("WITCHER.Doc.BrawlMixin.Text.EveryoneHeld", "everyone they were holding");
            await ChatMessage.create({
                speaker,
                content:
                    `<div class="wdm-attack-card">` +
                        tFormat("WITCHER.Doc.BrawlMixin.Text.ReleasesHold", { name: esc(this.name), list: esc(list) }, `<b>${esc(this.name)}</b> releases ${esc(list)} — the hold ends.`) +
                    `</div>`
            });
            return { declaration: decl, kind: "releaseGrapple", released: releasedNames };
        }

        // Escape — RAW Core "Brawling & Wrestling": "Each turn, your opponent
        // can attempt a Dodge/Escape roll against your Brawling to slip
        // loose." Same wording for Pin. Escape rolls Athletics (Dodge/Escape
        // is a DEX-based check in RAW; Athletics is our system's stand-in
        // key) and compares to the holder's Brawling. On success, clear the
        // pair — if the escaper is in multiple holds (multi-clinch), one
        // Escape action attempts a roll against EACH holder; each pair that
        // beats its holder is cleared independently.
        if (meta.isEscape) {
            const pairs = await getHoldLinks(this);
            /* Escape only frees holds ON you (role: target) — not holds you
             * yourself maintain. */
            const asTarget = pairs.filter(p => p.role === "target");
            if (asTarget.length === 0) {
                ui.notifications?.warn(tFormat("WITCHER.Doc.BrawlMixin.Notify.NotHeld", { actor: this.name }, "{actor} isn't currently held — nothing to escape."));
                return null;
            }
            /* LAYERED escape — one Dodge/Escape action peels the TOP layer only
             * (precedence chokeheld > pinned > grappled > clinched). A pinned+
             * grappled victim escapes the PIN first (back to a grapple), then
             * must Escape again to break the grapple. The opposed roll is vs the
             * holder(s) of THAT top layer only — so a stacked hold no longer
             * makes the grappler roll twice. Multi-hold at the SAME layer (e.g.
             * grappled by two foes) still rolls each holder and the hardest grip
             * decides (one action frees them all at that layer). */
            const ORDER = ["chokeheld", "pinned", "grappled", "clinched"];
            const topKind = ORDER.find(k => asTarget.some(p => p.kind === k));
            const escapePairs = asTarget.filter(p => p.kind === topKind);

            const escapeRoll = await this.rollSkill("dodge", { silent: false });
            const escapeTotal = Number(escapeRoll?.total) || 0;
            const holderResults = [];
            let hardestHolderTotal = -Infinity;
            let hardestHolder = null;
            const seenHolders = new Set();
            for (const pair of escapePairs) {
                if (seenHolders.has(pair.partnerUuid)) continue;   // one roll per holder
                seenHolders.add(pair.partnerUuid);
                const holder = await fromUuid(pair.partnerUuid).catch(() => null);
                if (!holder) continue;
                const holderRoll = await holder.rollSkill?.("brawling", { silent: false });
                const holderTotal = Number(holderRoll?.total) || 0;
                holderResults.push({ holder, holderName: holder.name, holderTotal });
                if (holderTotal > hardestHolderTotal) {
                    hardestHolderTotal = holderTotal;
                    hardestHolder = holder;
                }
            }
            const wonAll = holderResults.length > 0 && escapeTotal > hardestHolderTotal;
            if (wonAll) {
                /* Peel just the top-layer pairs (kind-filtered clear). The
                 * hold-family status strips from both sides of each cleared
                 * pair — chokehold's suffocation rider too — inside
                 * _doClearHoldLink. */
                const { clearHoldLink } = await import("../../mechanics/holdLink.mjs");
                for (const p of escapePairs) {
                    const holderActor = await fromUuid(p.partnerUuid).catch(() => null);
                    await clearHoldLink(this, "escape", holderActor, topKind);
                }
            }
            /* Post a summary card so the table sees the outcome. */
            const holdersLine = holderResults.map(r =>
                tFormat("WITCHER.Doc.BrawlMixin.Text.HolderLine", { name: esc(r.holderName), total: r.holderTotal, hardest: r.holder === hardestHolder ? ` <span style='opacity:.7;'>${t("WITCHER.Doc.BrawlMixin.Text.HardestGrip", "(hardest grip)")}</span>` : "" }, `<div><b>${esc(r.holderName)}</b>: Brawling <b>${r.holderTotal}</b>${r.holder === hardestHolder ? " <span style='opacity:.7;'>(hardest grip)</span>" : ""}</div>`)
            ).join("");
            const _layerName = ({ chokeheld: "chokehold", pinned: "pin", grappled: "grapple", clinched: "clinch" })[topKind] ?? "hold";
            const verdict = wonAll
                ? `<div style="color:#4a4">${tFormat("WITCHER.Doc.BrawlMixin.Text.EscapeLayerSuccess", { name: esc(this.name), layer: _layerName }, `<b>${esc(this.name)}</b> breaks the ${_layerName}.`)}</div>`
                : `<div style="color:#a44">${tFormat("WITCHER.Doc.BrawlMixin.Text.EscapeFail", { name: esc(this.name) }, `<b>${esc(this.name)}</b> can't break free — still held.`)}</div>`;
            const holdersSuffix = holderResults.length > 1 ? tFormat("WITCHER.Doc.BrawlMixin.Text.VsNHolders", { n: holderResults.length }, ` (vs ${holderResults.length} holders — highest wins)`) : "";
            await ChatMessage.create({
                speaker,
                content: `<div class="wdm-attack-card">${tFormat("WITCHER.Doc.BrawlMixin.Text.EscapeRollHeader", { name: esc(this.name), total: escapeTotal, suffix: holdersSuffix }, `<b>${esc(this.name)}</b> — Escape roll: <b>${escapeTotal}</b>${holdersSuffix}`)}${holdersLine}${verdict}</div>`
            });
            return {
                declaration: decl, kind: "escape",
                escapeTotal, hardestHolderTotal, won: wonAll,
                holders: holderResults.map(r => ({ holderName: r.holderName, holderTotal: r.holderTotal }))
            };
        }

        // Resolve the hit location for a damaging strike. Random shots roll now
        // (penalty already 0); called shots carried their penalty in modTotal and
        // only contribute the damage multiplier (subtracted after SP).
        let loc = decl.location;
        if (meta.isDisarm) {
            /* Disarm always strikes the WEAPON ARM. The −4 to-hit already prices
             * in the precise called shot, so no extra location penalty — just the
             * arm's ½ damage multiplier. */
            const def = ATTACK_LOCATIONS.leftArm;
            loc = { mode: "specific", key: "leftArm", penalty: 0, mult: def?.mult ?? 0.5,
                    label: L(def?.labelKey ?? "leftArm") };
        } else if (loc.mode === "random") {
            const { loc: key, face } = await rollHitLocation(loc.kind);
            const def = ATTACK_LOCATIONS[key];
            loc = { mode: "random", kind: loc.kind, key, face, penalty: 0, mult: def?.mult ?? 1,
                    label: L(def?.labelKey ?? key) };
        }
        const locMult  = loc.mult ?? 1;
        const locLabel = loc.mode === "random" ? `${loc.label} (d10: ${loc.face})`
                       : loc.mode === "specific" ? loc.label : "";

        // Grapple-chain prerequisite gate — pin / choke / throw / trip
        // (RAW Core p.160) require this actor to already be holding the
        // target in a grapple pair. Not just "some grapple exists in the
        // world" or "the target's grappled by someone" — specifically:
        // THIS attacker must have a pair against THIS target. RAW is
        // explicit that these follow-up actions land on the already-held
        // opponent. If the pair isn't there, refuse the action outright
        // (post-refactor: no more silent "flag it in the note and fire
        // anyway" behavior).
        /* Resolve targets: token targets first (Foundry's canonical
         * targeting), then fall back to the tokenless actor-target
         * flag (`actorTargetUuid`) for theatre-of-mind play. Matches
         * the same resolution order weaponAttack uses (`_defenderActor`
         * in weaponAttackMixin) so Pin/Choke/Throw work equally on
         * combat-tracker targets. */
        /* `options.forceDefender` — an explicit defender routed in by the
         * canvas tile-targeting overlay. Bypasses game.user.targets entirely
         * so brawling on the canvas no longer needs to set (and leave) a
         * Foundry target-lock / chevron on the victim. */
        let grappleTargets = options.forceDefender
            ? [options.forceDefender]
            : [...(game.user?.targets ?? [])].map(t => t.actor).filter(Boolean);
        if (!options.forceDefender && grappleTargets.length === 0) {
            try {
                const { getActorTarget } = await import("../../chrome/chrome/context-menu-actor.js");
                const tokenlessTarget = await getActorTarget?.();
                if (tokenlessTarget) grappleTargets = [tokenlessTarget];
            } catch (_) { /* module not loaded — fall through with empty list */ }
        }
        /* Trip and Disarm are grapple actions in BOTH modes now — they carry
         * `needsGrapple` directly in BRAWL_ACTIONS, so there's no CE-only
         * injection here. */
        if (meta.needsGrapple) {
            if (grappleTargets.length === 0) {
                ui.notifications?.warn(tFormat("WITCHER.Doc.BrawlMixin.Notify.NeedsGrappleNoTarget", { action: L(meta.labelKey) }, `${L(meta.labelKey)} requires an active grapple — pick the target you're already holding.`));
                return null;
            }
            const notHeld = [];
            for (const target of grappleTargets) {
                if (!(await attackerHoldsTarget(this, target))) notHeld.push(target.name);
            }
            if (notHeld.length > 0) {
                const key = notHeld.length > 1
                    ? "WITCHER.Doc.BrawlMixin.Notify.NeedsGrappleWithTargets"
                    : "WITCHER.Doc.BrawlMixin.Notify.NeedsGrappleWithTarget";
                ui.notifications?.warn(tFormat(key, { action: L(meta.labelKey), targets: notHeld.join(", ") }, `${L(meta.labelKey)} requires an active grapple with the target${notHeld.length > 1 ? "s" : ""}: ${notHeld.join(", ")}.`));
                return null;
            }
        }
        /* Either-role grapple gate (Takedown): the actor must be in a grapple /
         * pin with the target as EITHER the holder OR the grapplee. */
        if (meta.needsGrappleAnyRole) {
            if (grappleTargets.length === 0) {
                ui.notifications?.warn(tFormat("WITCHER.Doc.BrawlMixin.Notify.NeedsGrappleNoTarget", { action: L(meta.labelKey) }, `${L(meta.labelKey)} requires an active grapple — pick the foe you're locked with.`));
                return null;
            }
            const notIn = [];
            for (const target of grappleTargets) {
                const inWith = (await attackerHoldsTarget(this, target)) || isHeldByFoe(this, target);
                if (!inWith) notIn.push(target.name);
            }
            if (notIn.length > 0) {
                ui.notifications?.warn(tFormat("WITCHER.Doc.BrawlMixin.Notify.NeedsGrappleWithTarget", { action: L(meta.labelKey), targets: notIn.join(", ") }, `${L(meta.labelKey)} requires you to be grappling (or grappled by): ${notIn.join(", ")}.`));
                return null;
            }
        }
        /* Choke gate. Combat Extended: only on a foe you have PINNED (you must be
         * the pinner). RAW: you only need to be GRAPPLING them (RAW p.161 —
         * "after grappling a target, you can roll to attempt to choke them"). */
        if (meta.needsPin) {
            if (isCombatExtendedEnabled()) {
                const { pinsTarget } = await import("../../mechanics/holdModifiers.mjs");
                const notPinned = grappleTargets.filter(tg => !pinsTarget(this, tg)).map(tg => tg.name);
                if (grappleTargets.length === 0 || notPinned.length > 0) {
                    ui.notifications?.warn(tFormat("WITCHER.Brawl.ChokeNeedsPin", { targets: notPinned.join(", ") || this.name }, "Choke can only be used on a foe you have PINNED first."));
                    return null;
                }
            } else {
                const notHeld = [];
                for (const target of grappleTargets) {
                    if (!(await attackerHoldsTarget(this, target))) notHeld.push(target.name);
                }
                if (grappleTargets.length === 0 || notHeld.length > 0) {
                    ui.notifications?.warn(tFormat("WITCHER.Brawl.ChokeNeedsGrapple", { targets: notHeld.join(", ") || this.name }, "Choke can only be used on a foe you're grappling."));
                    return null;
                }
            }
        }
        /* Pin — Combat Extended requires the foe be PRONE or backed against a
         * WALL first (you can't pin someone standing in the open). RAW has no
         * such restriction: while grappling you can just pin. */
        if (decl.action === "pin" && isCombatExtendedEnabled()) {
            const { isTokenAgainstWall } = await import("../../mechanics/pushToken.mjs");
            for (const target of grappleTargets) {
                const tok = target.getActiveTokens?.()?.[0];
                const ok  = target.statuses?.has?.("prone") || (tok && isTokenAgainstWall(tok));
                if (!ok) {
                    ui.notifications?.warn(t("WITCHER.Brawl.PinNeedsProneOrWall", "You can only pin a foe that's prone or backed against a wall."));
                    return null;
                }
            }
        }
        /* Takedown needs BOTH combatants standing. */
        if (decl.action === "takedown") {
            if (this.statuses?.has?.("prone")) {
                ui.notifications?.warn(t("WITCHER.Brawl.TakedownSelfProne", "You must be standing to take someone down — get up first."));
                return null;
            }
            if (grappleTargets.some(tg => tg?.statuses?.has?.("prone"))) {
                ui.notifications?.warn(t("WITCHER.Brawl.TakedownTargetProne", "You can't take down a target that's already prone."));
                return null;
            }
        }
        /* Trip needs the TARGET standing — you can't trip a foe already on the
         * floor. The grappler stays upright (no self-prone), so no self check. */
        if (decl.action === "trip" && grappleTargets.some(tg => tg?.statuses?.has?.("prone"))) {
            ui.notifications?.warn(t("WITCHER.Brawl.TripTargetProne", "You can't trip a target that's already prone."));
            return null;
        }
        /* RAW Trip just knocks the foe prone — no damage. Combat Extended adds
         * the non-lethal punch (strip the damage under RAW so only the prone
         * status lands). */
        if (decl.action === "trip" && !isCombatExtendedEnabled()) {
            meta = { ...meta, damage: null };
        }
        /* Choke is applied ONCE. You can't re-Choke a foe you already choke —
         * the option is hidden in the pickers when the hold exists, and the
         * per-turn UPKEEP prompt (mechanics/choke) deals the damage each turn.
         * Guard here too in case something routes a stale declaration through. */
        if (meta.isChoke && grappleTargets.length === 1) {
            const _tgtUuid = normalizedActorUuid(grappleTargets[0]);
            const alreadyChoking = (await getHoldLinks(this)).some(p =>
                p.kind === "chokeheld" && p.role === "holder" && p.partnerUuid === _tgtUuid);
            if (alreadyChoking) {
                ui.notifications?.info(tFormat("WITCHER.Brawl.ChokeAlready", { name: grappleTargets[0].name }, "You're already choking {name} — it's maintained on your turn."));
                return null;
            }
        }
        /* Drag — a PHYSIQUE vs PHYSIQUE test (auto-rolled, no defender prompt),
         * NOT a combat exchange, so the whole flow (opposed roll → reachable
         * overlay → hold-preserving move of the pair) lives in mechanics/drag and
         * returns before the normal opposed flow. */
        if (meta.isDrag) {
            const { performDrag } = await import("../../mechanics/drag.mjs");
            const res = await performDrag(this, grappleTargets[0]);
            return { declaration: decl, kind: "drag", dragged: res?.dragged ?? 0 };
        }
        /* Can't slam while you're on the ground — Slam needs you upright. */
        if (decl.action === "slam" && this.statuses?.has?.("prone")) {
            ui.notifications?.warn(t("WITCHER.Brawl.SlamProne", "You can't slam while prone — get up first."));
            return null;
        }
        /* Can't push a prone target — they're already down. */
        if (decl.action === "push" && grappleTargets.some(tg => tg?.statuses?.has?.("prone"))) {
            ui.notifications?.warn(t("WITCHER.Brawl.PushTargetProne", "You can't push a prone target — there's nothing to shove back."));
            return null;
        }
        /* Slam — double kick damage (same doubling as the CE Trip
         * enhancement). meta already carries kick / prone / 1d6 knockback
         * / stun save / breaksHolds from BRAWL_ACTIONS; the grapple prereq
         * above already confirmed the target is held. */
        if (decl.action === "slam") {
            strikeMeta = { ...strikeMeta, dmgMult: 2 };
        }
        /* Adjacency gate — HOISTED. Every brawl action (punch, kick, all
         * grapple variants) is a physical melee strike; the actor must
         * be within one tile of the target. Previously this check ran
         * only inside `applyHoldLink`, so a player would go through the
         * dialog, spend an action slot, roll, and only THEN see the
         * "not adjacent" warning — the turn was already gone. Refuse
         * upstream, before the defense request and the attacker's
         * roll. Tokenless targets (theatre-of-mind) skip: no canvas =
         * no measurable distance, and applyHoldLink's inner prompt
         * still handles the null case for the hold family. Escape is
         * a self-directed action and doesn't hit this branch (it
         * short-circuited above). */
        if (grappleTargets.length) {
            const outOfReach = [];
            for (const t of grappleTargets) {
                if (areActorsAdjacent(this, t) === false) outOfReach.push(t.name);
            }
            if (outOfReach.length) {
                const listed = outOfReach.join(", ");
                const msg = game.i18n?.format?.("WITCHER.Clinch.NotAdjacent",
                    { holder: this.name, target: listed })
                    ?? `${this.name} isn't within reach of ${listed} — step adjacent (within 1 tile) before brawling.`;
                ui.notifications?.warn(msg);
                return null;
            }
        }

        // OPPOSED-CHECK actions — RAW: every melee attack is opposed
        // against the defender's chosen defense (parry / block / dodge /
        // reposition). Brawl actions covered:
        //   - grapple family (grapple, clinch, pin, choke, throw, trip):
        //     status apply gated on beating the defender's total.
        //   - regular attack family (punch, kick, push kick, charge):
        //     damage rolls regardless of outcome (the chat card still
        //     shows the roll), but the on-hit STATUS (e.g. prone from
        //     push kick) and follow-up ridings only fire if the
        //     attacker beat the defense — same rule the weapon-attack
        //     pipeline uses (`delta > 0`).
        // Both kinds send a `requestDefenseFromOwner` prompt so the
        // defender's owner (or GM for NPCs) gets to pick + roll before
        // the attacker's total settles.
        const isGrapple = meta.kind === "grapple" && !!meta.status;
        const isPlainAttack = meta.kind === "attack";
        /* Disarm (grapple + melee) is an OPPOSED action too — it deals damage on
         * a WIN but carries no hold status, so it wouldn't otherwise satisfy the
         * isGrapple/isPlainAttack test. Fold it in explicitly. */
        const isOpposedAction = (isGrapple || isPlainAttack || meta.isDisarm)
            && grappleTargets.length > 0;
        const opposedTarget = isOpposedAction ? grappleTargets[0] : null;

        const noteParts = [];
        /* RAW mode uses the action's plain `rawNote` when present; CE keeps the CE `note`. */
        const _noteKey = (!isCombatExtendedEnabled() && meta.rawNote) ? meta.rawNote : meta.note;
        if (_noteKey) noteParts.push(esc(L(_noteKey)));
        // Push Kick distance (RAW p.159): body/3 meters of knockback,
        // surfaced as a pre-roll note so the attacker sees the expected
        // push distance. The rider block after the hit resolution
        // actually MOVES the target's token (via pushToken() below);
        // this line is purely informational. Floor to whole metres.
        if (meta.pushBackFormula === "body/3") {
            const body = Number(this.system?.stats?.body?.value) || 0;
            const push = Math.floor(body / 3);
            if (push > 0) noteParts.push(esc(tFormat("WITCHER.Doc.BrawlMixin.Text.PushBackKick", { push }, `Push back ${push}m on a successful kick.`)));
        } else if (meta.pushBackFormula === "phy/5floor") {
            /* Physique BASE = BODY stat + Physique skill (not the skill alone). ÷5, rounded DOWN. */
            const phy = (Number(this.system?.stats?.body?.value) || 0) + (Number(this.system?.skills?.body?.physique?.value) || 0);
            const push = Math.floor(phy / 5);
            if (push > 0) noteParts.push(esc(tFormat("WITCHER.Doc.BrawlMixin.Text.PushBackShove", { push }, `Push back ${push}m on a successful shove.`)));
        } else if (meta.pushBackFormula === "1d6") {
            noteParts.push(esc(t("WITCHER.Doc.BrawlMixin.Text.ThrowDistance", "Throw distance: 1d6m on a successful trip.")));
        }
        /* The grapple-chain prerequisite (needsGrapple: pin/choke/throw/
         * trip against a non-held target) is now enforced upstream —
         * the action refuses to fire and this block doesn't run. No
         * follow-up warning line needed. */
        const note = noteParts.join("<br>");

        const damage = brawlDamage(this, meta, strikeMeta);
        /* Natural Weapons: a race can override unarmed's default non-lethal
         * bludgeoning with a damage type, lethality (non-lethal → stamina), and
         * qualities (Bleeding, etc.) that ride the strike through the damage
         * pipeline. Without one, unarmed stays non-lethal (Core). */
        const nwCfg     = naturalWeaponConfig(this);
        /* Effective natural-weapon damage types: the wielder's dialog pick
         * narrows the configured list; an empty pick falls back to all
         * configured types. Empty (no natural weapon) → default unarmed. */
        const _nwEffTypes = (meta.damage && nwCfg)
            ? (Array.isArray(decl.damageTypes) && decl.damageTypes.length ? decl.damageTypes : nwCfg.types)
            : [];
        /* "Pulled blow": "nonlethal" was chosen (or is the only configured
         * type). The strike lands as BLUNT damage to STAMINA even if the
         * natural weapon is otherwise flagged lethal — overriding both the
         * lethality and the resistance type. */
        const _nwPulledBlow = _nwEffTypes.includes("nonlethal");
        /* meta.nonLethal (e.g. Takedown) forces a pulled blow to STAMINA
         * regardless of the natural-weapon lethality. */
        const nwNonLethal = (meta.nonLethal === true) || (_nwPulledBlow ? true : (nwCfg ? !nwCfg.lethal : true));
        const nwTypeKeys  = _nwPulledBlow ? ["bludgeoning"] : _nwEffTypes;
        const nwTypeLabel = nwTypeKeys
            .map(k => game.i18n.localize(CONFIG.WITCHER?.damageTypes?.[k] ?? k))
            .join(" / ");
        const types  = meta.damage
            ? [nwTypeLabel || null, nwNonLethal ? L("WITCHER.Brawl.NonLethal") : null].filter(Boolean).join(" · ")
            : "";
        const nwQualities     = (meta.damage && nwCfg) ? nwCfg.qualities : [];
        const nwQualityValues = (meta.damage && nwCfg) ? nwCfg.qualityValues : {};
        const subtitle = [L("WITCHER.skills.brawling.label"), types].filter(Boolean).join(" · ");

        // Opposed-check prep: for a grapple/pin/choke-family action, request
        // the defender's reaction BEFORE the attacker rolls so the flow
        // matches the weapon-attack path (defender picks dodge/reposition,
        // rolls, and the attacker's roll then races the defender's total).
        // This is what makes grapple properly OPPOSED in RAW — the previous
        // implementation applied the status without a comparison at all.
        let opposedChoice = null;
        if (isOpposedAction) {
            try {
                /* Grapple family stays gated to dodge/reposition per
                 * DEFENSE_GATE.grapple (RAW p.163). Regular attacks
                 * (punch, kick, push kick, charge) open the full gate
                 * — parry / block / dodge / reposition are all valid
                 * defenses against an unarmed strike. Passing "normal"
                 * as the attackKind hits DEFENSE_GATE's default which
                 * enables all four defenses. */
                opposedChoice = await requestDefenseFromOwner({
                    defenderActor: opposedTarget,
                    attackerName:  this.name,
                    weaponName:    L(meta.labelKey),
                    weaponImg:     "",
                    engagementId:  `brawl-${Date.now()}-${Math.random().toString(36).slice(2)}`,
                    /* Choke resists with Brawling ONLY (its own DEFENSE_GATE +
                     * CE override) — pass "choke" so it isn't lumped under the
                     * looser "grapple" gate (which allows dodge/relocate). Other
                     * grapple actions stay "grapple"; push has its own gate; a
                     * plain punch/kick is "normal". */
                    attackKind:    meta.isDisarm ? "disarm"
                        : isGrapple ? (decl.action === "choke" ? "choke" : "grapple")
                        : (decl.action === "push" ? "push" : "normal"),
                    attackerUuid:  this.uuid
                });
            } catch (err) {
                console.warn("witcher-ttrpg-death-march | brawl defense request failed", err);
                opposedChoice = { action: "none" };
            }
        }
        /* No-defense / timed-out fold: mirrors the weapon-attack
         * pipeline's DC 10 auto-hit rule. A grappled or pinned target
         * often has no valid defense (dodge / reposition need movement
         * they can't take), so the defender's owner picks "none" — or
         * the request times out. Without this fold, `defenseTotal`
         * stayed null, `firstShotBeat` never went true, and Throw's
         * prone rider + stun-save never fired even on a clean win.
         * Weapon flow uses DC 10 (Core "helpless target" rule); brawl
         * follows suit for consistency. Also flags a `_dc10Pass` tag
         * so the defense line reads "took no defense — DC 10" instead
         * of "chose none". */
        if (opposedChoice
            && (opposedChoice.action === "none" || opposedChoice.timedOut === true)) {
            opposedChoice.defenseTotal = 10;
            opposedChoice._dc10Pass = true;
        }
        /* Helpless-target fold: pinned / paralyzed / stunned / unconscious
         * targets are hit on the clause's incomingDC (10 by default —
         * RAW Core "Brawling & Wrestling" for pin; Core p.161 for the
         * paralyzed / unconscious cases). Applied regardless of what
         * defense the target picked — even a lucky dodge roll can't
         * exceed the helpless floor, because RAW makes the roll itself
         * irrelevant against a locked-down target. */
        if (isOpposedAction && opposedTarget) {
            try {
                const { incomingAttackDC } = await import("../../mechanics/statusEngine.mjs");
                const helplessDC = incomingAttackDC(opposedTarget);
                if (typeof helplessDC === "number") {
                    const prior = Number(opposedChoice?.defenseTotal);
                    opposedChoice ??= { action: "none" };
                    opposedChoice.defenseTotal = Number.isFinite(prior)
                        ? Math.min(prior, helplessDC)
                        : helplessDC;
                    opposedChoice._helplessDC = helplessDC;
                }
            } catch (_) { /* ignore — fall back to whatever defense picked */ }
        }
        const defenseTotal = Number(opposedChoice?.defenseTotal);
        const hasDefenseTotal = Number.isFinite(defenseTotal);
        /* Defense line for the card — shown on every opposed brawl
         * attack so the table sees exactly what the defender picked
         * and rolled. Mirrors the wdm-attack-defense block used by
         * the weapon-attack pipeline for visual consistency. */
        const defenseInfoLine = (() => {
            if (!isOpposedAction) return "";
            const act = opposedChoice?.action;
            if (opposedChoice?._dc10Pass) {
                return `<div class="wdm-attack-defense"><span class="wdm-attack-defense-k">${t("WITCHER.Doc.BrawlMixin.Text.Defense", "Defense")}</span> <span class="wdm-attack-defense-v"><b>${esc(opposedTarget?.name ?? t("WITCHER.Doc.BrawlMixin.Text.Defender", "Defender"))}</b> took no defense → <b>DC 10</b></span></div>`;
            }
            if (!act || act === "none") return "";
            let label = act.charAt(0).toUpperCase() + act.slice(1);
            /* brawlBlock → the grappling weapon's name (if one was chosen) or
             * plain "Brawling"; dodge → "Dodge" — never the raw action key. */
            if (act === "brawlBlock") {
                const _gw = opposedChoice?.itemId ? opposedTarget?.items?.get?.(opposedChoice.itemId) : null;
                label = _gw?.name ?? t("WITCHER.Common.Brawling", "Brawling");
            } else if (act === "dodge") {
                label = t("WITCHER.Common.Dodge", "Dodge");
            }
            const totalTxt = hasDefenseTotal ? String(defenseTotal) : "—";
            /* Show the defender's own modifier breakdown (stat/skill/status +
             * any Grappled/Grappling hold penalty) so the table sees exactly
             * what they rolled and why — same chip strip the weapon pipeline
             * renders. */
            const chipRowHtml = (Array.isArray(opposedChoice?.defenseChips) && opposedChoice.defenseChips.length)
                ? `<div class="wdm-attack-defense-chips" style="display:flex;flex-wrap:wrap;gap:3px;margin-top:3px;">${
                    opposedChoice.defenseChips.filter(c => c && c.value != null && c.value !== "")
                        .map(c => `<span class="wdm-chip wdm-chip-def"><span class="wdm-chip-k">${esc(c.label)}</span><span class="wdm-chip-v">${esc(c.value)}</span></span>`).join("")
                }</div>`
                : "";
            return `<div class="wdm-attack-defense"><span class="wdm-attack-defense-k">${t("WITCHER.Doc.BrawlMixin.Text.Defense", "Defense")}</span> <span class="wdm-attack-defense-v"><b>${esc(opposedTarget?.name ?? t("WITCHER.Doc.BrawlMixin.Text.Defender", "Defender"))}</b> chose <b>${esc(label)}</b> → <b>${esc(totalTxt)}</b></span>${chipRowHtml}</div>`;
        })();

        /* CE Combat Extended — grappler/pinner physical penalty on
         * BRAWL attacks. Mirrors the weaponAttackMixin fold. Zero when
         * CE off, when the attacker isn't a holder of any grappling/
         * pinning pair, or when the target IS their held partner
         * (the "except vs the one you hold" carve-out). Non-null chip
         * surfaces on the card for player + GM visibility.
         *
         * Without this the punch/kick/grapple rolls a grappler makes
         * against OTHER foes would skip the -2 penalty their weapon
         * strikes already pay. */
        const ceBrawlHoldMod  = contextualPhysicalMod(this, opposedTarget);
        const ceBrawlHoldChip = contextualPhysicalChip(this, opposedTarget);
        /* Status penalties (Grappled −2, Prone −2, Staggered −2, Exhausted
         * −1, …) folded straight onto the to-hit. Mirrors the weaponAttackMixin
         * `statusAtk` fold at line ~2539 — brawl attacks were silently
         * skipping these because brawlAttack builds its own grandMod from the
         * dialog result and never asked the status engine. Chips per active
         * status are computed inline (no shared helper import here) since
         * brawlMixin already reads `mods.roll.all`-shaped clauses via
         * _clauseFor. */
        const statusAtk = statusAttackMod(this);
        const statusAtkChips = [];
        for (const id of (this.statuses ?? [])) {
            const roll = _clauseFor(id, this)?.mods?.roll;
            if (!roll) continue;
            const v = (Number(roll.attack) || 0) + (Number(roll.all) || 0);
            if (!v) continue;
            statusAtkChips.push({ label: id.charAt(0).toUpperCase() + id.slice(1), value: signed(v) });
        }
        const effectiveGrandMod = (decl.grandMod ?? 0) + ceBrawlHoldMod + statusAtk;

        const attacks = Math.max(1, decl.strikeMeta?.attacks ?? 1);
        let result = null;
        let firstShotBeat = false;   // did the first shot's attacker total beat the defense?
        for (let i = 0; i < attacks; i++) {
            const shotChips = [
                ...baseChips,
                ...decl.chips.map(c => ({ label: c.label, value: signed(c.value) })),
                ceBrawlHoldChip,
                ...statusAtkChips,
                loc.mode !== "none" ? { label: L("WITCHER.Attack.Location"), value: locLabel } : null
            ].filter(Boolean);
            /* On an opposed attack that the defender WON, the swing
             * misses — no damage rolls, no rider fires. Suppress the
             * damage block on the first shot's card (subsequent shots
             * already had empty damage). */
            const wouldBeMiss = isOpposedAction && hasDefenseTotal && !firstShotBeat && i > 0;
            /* The first-shot beat check needs to happen BEFORE this
             * decision — moved below the roll, so on i===0 we roll
             * first, THEN gate damage after computing firstShotBeat.
             * For the FIRST shot we render damage optimistically and
             * post a "Miss" follow-up if the roll came in short. */
            const shotDamage = (i === 0 && !wouldBeMiss) ? damage : { display: "", formula: "" };
            const actionName = attacks > 1 ? `${L(meta.labelKey)} (${i + 1}/${attacks})` : L(meta.labelKey);
            const noteWithDefense = i === 0
                ? [note, defenseInfoLine].filter(Boolean).join("<br>")
                : "";
            const flavor = brawlFlavor({
                actorName: this.name, actionName, subtitle, chips: shotChips,
                damage: {
                    ...shotDamage, types, locMult,
                    locLabel: loc.label, locKey: loc.key,
                    typeKeys: nwTypeKeys, nonLethal: nwNonLethal,
                    qualities: nwQualities, qualityValues: nwQualityValues
                },
                note: noteWithDefense
            });
            result = await extendedRoll(effectiveGrandMod ? `1d10 + ${effectiveGrandMod}` : `1d10`,
                { speaker, flavor, flags: { "witcher-ttrpg-death-march": { category: "combat" } } },
                { fumbleCategory: "unarmedAttack" });
            if (i === 0) {
                const atkTotal = Number(result?.total);
                if (isOpposedAction) {
                    firstShotBeat = hasDefenseTotal
                        && Number.isFinite(atkTotal)
                        && atkTotal > defenseTotal;
                }
                /* Stamp target + crit data on the first-shot card so the shared
                 * Roll-Damage handler resolves the defender (no spurious
                 * "Assign Target" button on an already-targeted brawl) AND
                 * computes crit severity — unarmed now crits like a weapon.
                 * Uses dot-notation so the existing `category` flag survives. */
                if (result?.message && meta.damage) {
                    const dt    = hasDefenseTotal ? defenseTotal : null;
                    const delta = (Number.isFinite(atkTotal) && dt != null) ? (atkTotal - dt) : null;
                    /* All unarmed strikes can crit for BONUS DAMAGE (non-lethal
                     * routes it to stamina). Only LETHAL strikes also inflict a
                     * critical WOUND — the nonLethal flag on the damage payload
                     * gates the wound downstream (handleApplyDamage). */
                    const sev   = (delta != null && delta > 0)
                        ? critSeverityFromDelta(delta, hrCritBrackets())
                        : null;
                    const upd = {};
                    if (opposedTarget?.uuid)       upd["flags.witcher-ttrpg-death-march.defenderUuid"] = opposedTarget.uuid;
                    if (Number.isFinite(atkTotal)) upd["flags.witcher-ttrpg-death-march.attackTotal"]  = atkTotal;
                    if (dt != null)                upd["flags.witcher-ttrpg-death-march.defenseTotal"]  = dt;
                    upd["flags.witcher-ttrpg-death-march.critSeverity"] = sev;
                    upd["flags.witcher-ttrpg-death-march.critDelta"]    = delta;
                    try { await result.message.update(upd); } catch (_) { /* best-effort */ }
                }
            }
        }

        /* The attack roll card. Riders below (knockback, ramming) fold into
         * THIS single card instead of posting standalone chat messages —
         * captured here because the pushback block shadows `result` with the
         * pushToken result. */
        const attackCardMsg = result?.message ?? null;
        const foldIntoCard = async (html) => {
            if (attackCardMsg) {
                try {
                    const { appendAttackResult } = await import("./weaponAttackMixin.mjs");
                    await appendAttackResult(attackCardMsg, { fragment: html });
                    return;
                } catch (_) { /* fall through to a standalone card */ }
            }
            if (ChatMessage?.create) {
                try { await ChatMessage.create({ content: html, speaker }); }
                catch (_) { /* best-effort */ }
            }
        };

        /* Fumble pip — a natural 1 on a grapple-flow roll surfaces a FUMBLE chip
         * on the card header so it's unmistakable (the weapon flow does the same
         * on its own cards). Gated to grapple-flow actions per user spec. */
        const _isGrappleFlow = meta.kind === "grapple" || !!meta.needsGrapple || !!meta.breaksHolds || !!meta.status;
        if (result?.fumble && attackCardMsg && _isGrappleFlow) {
            try {
                const { appendAttackResult } = await import("./weaponAttackMixin.mjs");
                await appendAttackResult(attackCardMsg, {
                    summaryAdd: { label: t("WITCHER.Doc.WeaponAttackMixin.Text.FumbleBanner", "FUMBLE"), kind: "fumble", icon: "fa-triangle-exclamation" }
                });
            } catch (_) { /* best-effort */ }
        }

        /* Plain-attack miss follow-up: when a punch / kick / push kick /
         * charge was opposed and the defender's total >= attacker's,
         * the swing missed. Post a "miss" card so the table sees the
         * outcome even without a status rider (a plain punch has no
         * status; it just fails to hurt anyone). Grapple attacks
         * already surface their own beat/resist card via the meta.status
         * block below, so this only fires for the plain-attack case
         * where meta.status is absent. */
        if (isPlainAttack && !firstShotBeat && !meta.status) {
            await foldIntoCard(`<div class="wdm-attack-rider"><i class="fa-solid fa-shield"></i> <strong>${esc(opposedTarget?.name ?? t("WITCHER.Doc.BrawlMixin.Text.Defender", "Defender"))}</strong> beats the roll — the ${esc(L(meta.labelKey))} misses.</div>`);
        }

        // Apply the rider status. For opposed-check actions the status
        // only lands when the attacker's shot total beat the defender's
        // opposed total; otherwise the action fails and we post a
        // follow-up "resisted" card so the table sees the result. For
        // non-opposed brawl actions (punch/kick/push-kick etc. without
        // an opposed check target) the status still lands as a flat
        // rider from the hit.
        if (meta.status) {
            const statusDef = (CONFIG.statusEffects ?? []).find(s => s.id === meta.status);
            const statusLabel = statusDef?.name ? L(statusDef.name) : meta.status;
            /* Numeric proof-of-work on both messages: the roll totals are
             * the whole point of "did the check land?", so state them
             * inline so a GM adjudicating the outcome (or a player
             * debugging a suspicious "failed") can see the math without
             * cross-referencing the roll card. Includes the "DC 10 auto"
             * badge when the defender took no defense. */
            const atkTxt = Number.isFinite(Number(result?.total)) ? String(result.total) : "?";
            const defTxt = hasDefenseTotal
                ? (opposedChoice?._dc10Pass ? `${defenseTotal} (DC 10 auto)`
                    : opposedChoice?._helplessDC ? `${defenseTotal} (helpless DC)`
                    : String(defenseTotal))
                : "?";
            let followUpHtml = "";
            if (isOpposedAction) {
                if (firstShotBeat) {
                    const landed = await applyStatusToTarget(this, opposedTarget, meta.status);
                    followUpHtml = landed
                        ? `<div class="wdm-attack-rider"><i class="fa-solid fa-hand-fist"></i> ${tFormat("WITCHER.Doc.BrawlMixin.Text.BeatsOpposedApplied", { name: esc(this.name), atk: esc(atkTxt), def: esc(defTxt), target: esc(opposedTarget.name), status: esc(statusLabel) }, `<strong>${esc(this.name)}</strong> beats the opposed roll (<strong>${esc(atkTxt)}</strong> vs <strong>${esc(defTxt)}</strong>) — <strong>${esc(opposedTarget.name)}</strong> is now <strong>${esc(statusLabel)}</strong>.`)}</div>`
                        : `<div class="wdm-attack-rider"><i class="fa-solid fa-triangle-exclamation"></i> ${tFormat("WITCHER.Doc.BrawlMixin.Text.BeatsOpposedApplyFailed", { atk: esc(atkTxt), def: esc(defTxt), status: esc(statusLabel) }, `Beat the opposed roll (${esc(atkTxt)} vs ${esc(defTxt)}) but the ${esc(statusLabel)} apply failed — check tokens / adjacency.`)}</div>`;
                } else {
                    followUpHtml = `<div class="wdm-attack-rider"><i class="fa-solid fa-shield"></i> ${tFormat("WITCHER.Doc.BrawlMixin.Text.OpposedTargetWins", { target: esc(opposedTarget?.name ?? t("WITCHER.Doc.BrawlMixin.Text.Target", "Target")), atk: esc(atkTxt), def: esc(defTxt), status: esc(statusLabel) }, `<strong>${esc(opposedTarget?.name ?? "Target")}</strong> wins the opposed roll (<strong>${esc(atkTxt)}</strong> vs <strong>${esc(defTxt)}</strong>) — the ${esc(statusLabel)} attempt fails.`)}</div>`;
                }
            } else {
                // Non-opposed brawl status apply — one target at a time.
                const appliedNames = [];
                for (const t of grappleTargets) {
                    if (await applyStatusToTarget(this, t, meta.status)) appliedNames.push(t.name);
                }
                followUpHtml = appliedNames.length
                    ? `<div class="wdm-attack-rider"><i class="fa-solid fa-hand-fist"></i> <strong>${esc(statusLabel)}</strong> applied to ${esc(appliedNames.join(", "))}.</div>`
                    : `<div class="wdm-attack-rider"><i class="fa-solid fa-info"></i> ${esc(statusLabel)} — apply manually (no valid target).</div>`;
            }
            /* Fold the opposed-check outcome into the attack card so the
             * whole exchange lives on one card. */
            if (followUpHtml) await foldIntoCard(followUpHtml);
        }

        /* Takedown — BOTH combatants go prone. The target's prone lands via the
         * status block above; the attacker drops too here. Prone no longer
         * breaks a grapple, so the hold is MAINTAINED. Success-gated. */
        if (meta.selfProne && (!isOpposedAction || firstShotBeat)) {
            try { await applyStatusToTarget(this, this, "prone"); }
            catch (err) { console.warn("witcher-ttrpg-death-march | takedown self-prone failed", err); }
        }

        /* Choke damage on the INITIAL application — one action's worth of
         * suffocation. Each following turn is dealt by the turn-start upkeep
         * prompt (mechanics/choke), or by re-invoking Choke as an extra action
         * (handled above). Success-gated; the `chokeheld` pair was created by the
         * status block above. */
        if (meta.isChoke && opposedTarget && (!isOpposedAction || firstShotBeat)) {
            try {
                /* Unarmed Brawling choke — no Strangling weapon, so no bonus. One
                 * action's worth of suffocation (flat, through armour + shield,
                 * stamina-then-HP). Restamps chokeRound for the upkeep tracker. */
                const { applyChokeDamage } = await import("../../mechanics/choke.mjs");
                const dmg = await applyChokeDamage(this, opposedTarget, null, { attackMessageUuid: result?.message?.uuid ?? null });
                await foldIntoCard(`<div class="wdm-attack-rider"><i class="fa-solid fa-lungs"></i> <strong>${esc(opposedTarget.name)}</strong> is choking — <strong>${dmg}</strong> suffocation (stamina, then HP; through armour).</div>`);
            } catch (err) { console.warn("witcher-ttrpg-death-march | choke damage failed", err); }
        }

        /* Push Kick rider (RAW p.159): on a successful kick, knock the
         * target back BODY/3 metres directly away from the attacker.
         * Fires only on a HIT — an opposed action needs firstShotBeat;
         * a non-opposed swing (no target token) can't determine a
         * direction so it silently no-ops (the "manual push" note on
         * the card still tells the GM the distance). Wall collision is
         * handled inside pushToken — a 3 m push into a wall 1 m behind
         * the target lands the token flush against the wall. */
        if (meta.pushBackFormula && opposedTarget && (!isOpposedAction || firstShotBeat)) {
            try {
                /* Distance formula:
                 *   "body/3" (RAW push kick): floor(BODY/3) meters.
                 *   "1d6" (CE Trip enhanced): roll 1d6 meters.
                 * Extend as new formulas land. Unknown formulas fall
                 * through to 0 and no push fires. */
                let pushM = 0;
                if (meta.pushBackFormula === "body/3") {
                    const body = Number(this.system?.stats?.body?.value) || 0;
                    pushM = Math.floor(body / 3);
                } else if (meta.pushBackFormula === "phy/5floor") {
                    /* Physique BASE = BODY stat + Physique skill (not the skill alone). ÷5, rounded DOWN. */
                    const phy = (Number(this.system?.stats?.body?.value) || 0) + (Number(this.system?.skills?.body?.physique?.value) || 0);
                    pushM = Math.floor(phy / 5);
                } else if (meta.pushBackFormula === "1d6") {
                    const roll = await new Roll("1d6").evaluate();
                    pushM = Number(roll.total) || 0;
                }
                const attackerToken = this.getActiveTokens?.()?.[0] ?? null;
                const targetToken   = opposedTarget.getActiveTokens?.()?.[0] ?? null;
                if (pushM > 0 && attackerToken && targetToken?.document?.uuid) {
                    let sourcePoint = {
                        x: Number(attackerToken.center?.x ?? attackerToken.x),
                        y: Number(attackerToken.center?.y ?? attackerToken.y)
                    };
                    /* Slam lets the attacker choose which way to hurl the foe.
                     * emitPushToken shoves AWAY from sourcePoint, so a point
                     * opposite the chosen direction sends them that way. Cancel
                     * → default away from the attacker. */
                    if (meta.pickDirection) {
                        try {
                            const tc = {
                                x: Number(targetToken.center?.x ?? targetToken.x),
                                y: Number(targetToken.center?.y ?? targetToken.y)
                            };
                            const gs = canvas?.dimensions?.size ?? 100;
                            const gm = canvas?.dimensions?.distance ?? 2;
                            const { pickPushDirection } = await import("../../applications/pushDirectionDialog.mjs");
                            const dir = await pickPushDirection(tc, { lengthPx: pushM * (gs / (gm || 1)) });
                            if (dir) {
                                sourcePoint = { x: tc.x - dir.x * gs, y: tc.y - dir.y * gs };
                            }
                        } catch (_) { /* keep the away-from-attacker default */ }
                    }
                    const result = await emitPushToken({
                        tokenUuid:       targetToken.document.uuid,
                        sourcePoint,
                        distanceMeters:  pushM
                    });
                    /* Post a follow-up card so the table sees the outcome
                     * — including whether the push clipped short on a
                     * wall so the GM can adjudicate the impact. */
                    const moved   = Number(result?.moved) || 0;
                    const clipped = !!result?.hitWall;
                    const wallTxt = clipped ? " — cut short against a wall" : "";
                    const distTxt = moved > 0
                        ? `${moved.toFixed(1)}m`
                        : `${pushM}m`;
                    const html = `<div class="wdm-attack-rider"><i class="fa-solid fa-arrows-left-right-to-line"></i> <strong>${esc(opposedTarget.name)}</strong> is knocked back <strong>${esc(distTxt)}</strong>${esc(wallTxt)}.</div>`;
                    await foldIntoCard(html);
                    /* Shoved into a wall — ramming damage, bludgeoning to the
                     * torso, bypassing worn/natural armour but NOT a magic shield
                     * (Quen/Barrier still soaks it). Two shapes:
                     *   - `wallRammingFormula` (Push Kick): a FLAT roll (1d6) on
                     *     any wall impact, however far they were shoved.
                     *   - default (Push / Slam): 1d6/2 per full 2m travelled. */
                    if (meta.wallRamming && clipped) {
                        try {
                            let wdmg = 0;
                            if (meta.wallRammingFormula) {
                                const rr = await new Roll(meta.wallRammingFormula).evaluate();
                                wdmg = Math.max(0, Math.floor(Number(rr.total) || 0));
                            } else if (moved >= 2) {
                                const inc = Math.floor(moved / 2);
                                const rr  = await new Roll(`${inc}d6`).evaluate();
                                wdmg = Math.floor((Number(rr.total) || 0) / 2);
                            }
                            if (wdmg > 0) {
                                await emitApplyDamage({
                                    targetUuid:    opposedTarget.uuid,
                                    weaponDamage:  wdmg,
                                    silverDamage:  0,
                                    damageTypes:   ["bludgeoning"],
                                    locationKey:   "torso",
                                    locationLabel: game.i18n.localize(ATTACK_LOCATIONS.torso?.labelKey ?? "torso"),
                                    bypassesWornArmor: true, bypassesNaturalArmor: true, sourceLabel: "Ramming",
                                    kind:          "weapon",
                                    attackMessageUuid: attackCardMsg?.uuid ?? null
                                });
                                await foldIntoCard(`<div class="wdm-attack-rider"><i class="fa-solid fa-person-falling-burst"></i> <strong>${esc(opposedTarget.name)}</strong> slams into the wall — <strong>${wdmg}</strong> ramming damage (torso, ignores armor).</div>`);
                            }
                        } catch (err) { console.warn("witcher-ttrpg-death-march | push wall ramming failed", err); }
                    }
                }
                /* Push breaks any hold the shoved target is in — grapple, pin,
                 * choke — whether they were the holder or the held: being
                 * knocked away separates them. (Clinch already breaks on the
                 * resulting movement.) */
                if (meta.breaksHolds) {
                    try {
                        const { clearHoldLink } = await import("../../mechanics/holdLink.mjs");
                        await clearHoldLink(opposedTarget, "push");
                    } catch (_) { /* best-effort */ }
                }
            } catch (err) {
                console.warn("witcher-ttrpg-death-march | push kick apply failed", err);
            }
        }

        // RAW Throw (Core "Brawling & Wrestling"): "The opponent is thrown
        // to the ground (prone), takes damage equal to your Punch damage,
        // and must make a Stun save at -1." The Stun save is a consequence
        // of the SUCCESSFUL throw — only fires when the attacker beat the
        // opposed roll (firstShotBeat). Previously fired unconditionally,
        // so a whiffed throw still gave the target a save-or-be-stunned
        // prompt they hadn't earned.
        const throwSucceeded = !isOpposedAction || firstShotBeat;
        if (meta.triggerStunSave?.mod != null && grappleTargets.length && throwSucceeded) {
            for (const a of grappleTargets) {
                if (typeof a.rollStunSave !== "function") continue;
                try { await a.rollStunSave({ modifier: meta.triggerStunSave.mod }); }
                catch (err) { console.warn("witcher-ttrpg-death-march | throw stun save failed", err); }
            }
        }

        /* Slam ramming — the SLAMMED person takes the impact: roll the formula
         * (1d6) as bludgeoning to their torso, bypassing physical armour SP but
         * NOT a magic shield (Quen/Barrier still catches it). ON TOP of the
         * double kick. Fires on a successful slam only. */
        if (meta.rammingFormula && throwSucceeded) {
            for (const tgt of grappleTargets) {
                try {
                    const roll = await new Roll(meta.rammingFormula).evaluate();
                    const dmg  = Math.max(0, Math.floor(Number(roll.total) || 0));
                    if (dmg > 0) {
                        await emitApplyDamage({
                            targetUuid:    tgt.uuid,
                            weaponDamage:  dmg,
                            silverDamage:  0,
                            damageTypes:   ["bludgeoning"],
                            locationKey:   "torso",
                            locationLabel: game.i18n.localize(ATTACK_LOCATIONS.torso?.labelKey ?? "torso"),
                            bypassesWornArmor: true, bypassesNaturalArmor: true, sourceLabel: "Ramming",
                            kind:          "weapon",
                            /* Fold the ramming damage breakdown into the attack card. */
                            attackMessageUuid: attackCardMsg?.uuid ?? null
                        });
                        await foldIntoCard(`<div class="wdm-attack-rider"><i class="fa-solid fa-heart-crack"></i> <strong>${esc(tgt.name)}</strong> takes <strong>${dmg}</strong> ramming damage from the impact (torso, ignores armor).</div>`);
                    }
                } catch (err) {
                    console.warn("witcher-ttrpg-death-march | slam ramming failed", err);
                }
            }
        }

        /* Disarm rider — post-hit note. Fires when the disarm lands (attacker
         * beat the defender's check). The weapon is knocked from the target's
         * WEAPON ARM: roll where it lands (1d8 direction, 1d6 metres), and offer
         * the attacker the DC 18 Brawling option to snatch it for themselves
         * instead. Item transfer / canvas placement stay flat — the GM resolves
         * the actual weapon by hand, same as the weapon-strike disarm scatter. */
        if (meta.isDisarm && opposedTarget && throwSucceeded && ChatMessage?.create) {
            try {
                const dirRoll  = await new Roll("1d8").evaluate();
                const distRoll = await new Roll("1d6").evaluate();
                const dirs = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"];
                const dir  = esc(dirs[(Number(dirRoll.total) - 1) % 8]);
                const dist = Number(distRoll.total) || 0;
                const dc18 = `<strong>${esc(t("WITCHER.Doc.BrawlMixin.Text.DC18Brawling", "DC 18 Brawling"))}</strong>`;
                /* The DC 18 weapon-steal is a Combat Extended addition — RAW just
                 * knocks the weapon away. (Melee Disarm also sets noSteal.) */
                const stealTxt = (isCombatExtendedEnabled() && !meta.noSteal)
                    ? ` — ` + tFormat("WITCHER.Doc.BrawlMixin.Text.DisarmSteal",
                        { attacker: esc(this.name), dc18 },
                        `or <strong>${esc(this.name)}</strong> may make a ${dc18} check to snatch it instead`)
                    : "";
                const html =
                    `<div class="wdm-attack-rider">` +
                        `<i class="fa-solid fa-hand-fist"></i> ` +
                        tFormat("WITCHER.Doc.BrawlMixin.Text.DisarmTossed",
                            { target: esc(opposedTarget.name), dist, dir },
                            `<strong>${esc(opposedTarget.name)}</strong>'s weapon is knocked <strong>${dist}m ${dir}</strong>`) +
                        stealTxt +
                        `. <span style="opacity:0.7;">(1d8=${dirRoll.total}, 1d6=${dist})</span>` +
                    `</div>`;
                await ChatMessage.create({ content: html, speaker });
            } catch (_) { /* best-effort */ }
        }

        /* Charge rider (RAW Core): "If the attack is blocked you can
         * make a Physique check against the opponent's Physique roll
         * to knock the target prone." Fires here when the brawl
         * action was Charge AND the defender picked block/brawlBlock
         * AND the block beat the attacker. Posts the same button
         * shape as the weapon-side rider — the shared chat handler
         * in weaponAttackMixin's installAttackChatHandlers catches
         * `data-action="wdm-charge-prone"` regardless of card origin. */
        const wasCharge   = decl.action === "charge";
        const defBlocked  = opposedChoice?.action === "block"
                         || opposedChoice?.action === "brawlBlock"
                         || opposedChoice?.action === "parry";
        const attackerLost = isOpposedAction && hasDefenseTotal && !firstShotBeat;
        if (wasCharge && defBlocked && attackerLost && opposedTarget) {
            try {
                const chargeFrag =
                    `<div class="wdm-attack-rider" data-charge-rider="1">` +
                        `<button type="button" class="wdm-attack-damage-roll" ` +
                            `data-action="wdm-charge-prone" ` +
                            `data-attacker-uuid="${esc(this.uuid)}" ` +
                            `data-target-uuid="${esc(opposedTarget.uuid ?? "")}">` +
                            `<i class="fa-solid fa-person-falling"></i> ` +
                            `Attempt to knock prone (Physique vs Physique)` +
                        `</button>` +
                    `</div>`;
                await ChatMessage.create({ content: chargeFrag, speaker });
            } catch (err) {
                console.warn("witcher-ttrpg-death-march | brawl charge prone rider post failed", err);
            }
        }

        return { declaration: decl, kind: meta.kind };
    }
};
