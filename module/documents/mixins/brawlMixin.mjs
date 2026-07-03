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
import { contextualPhysicalMod, contextualPhysicalChip } from "../../mechanics/holdModifiers.mjs";
import { openBrawlDialog } from "../../applications/brawlDialog.mjs";
import { ATTACK_LOCATIONS, rollHitLocation, getActiveWeaponQualities, WEAPON_QUALITIES } from "../../setup/config.mjs";
import { requestDefenseFromOwner, emitApplyStatus, emitPushToken } from "../../setup/socketHook.mjs";
import { applyHoldLink, getHoldLinks, HOLD_STATUSES, normalizedActorUuid, areActorsAdjacent } from "../../mechanics/holdLink.mjs";
import { attackMod as statusAttackMod, clauseFor as _clauseFor } from "../../mechanics/statusEngine.mjs";

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
            out.push({ name: String(a?.name || "Attack"), formula: dmg });
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
function brawlDamage(actor, meta, strikeMeta) {
    if (!meta.damage) return { display: "", formula: "" };
    const ds = actor.system?.derivedStats ?? {};
    const base = meta.damage === "kick" ? ds.kick : ds.punch;
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
            emitApplyStatus({ targetUuid: target.uuid, statusId, action: "apply" });
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
            ${damage.formula ? `<button type="button" class="wdm-attack-damage-roll" data-action="wdm-roll-damage" data-formula="${esc(damage.formula)}" data-types="${esc(damage.types ?? "")}" data-loc-mult="${esc(locMult)}" data-loc-label="${esc(damage.locLabel ?? "")}"><i class="fa-solid fa-burst"></i> ${esc(L("WITCHER.Attack.RollDamage"))}</button>` : ""}
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
        const baseChips = [
            { label: statName(sv.meta.statKey), value: sv.statVal },
            { label: "Rank", value: sv.skillVal },
            sv.skillMod ? { label: "Mod", value: signed(sv.skillMod) } : null
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
            decl = await openBrawlDialog(this, { base: { total: sv.total, chips: baseChips } });
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
            const grapplePair = pairs.find(p => p.kind === "grappled" && p.role === "target");
            if (!grapplePair) {
                ui.notifications?.warn(`${this.name} isn't currently grappled — nothing to reverse.`);
                return null;
            }
            /* CE spec: reversal is only available when the grappled
             * actor is NOT also pinned or choked. Once things escalate
             * past a plain grapple, Escape is the only way out. */
            const hasHardHold = pairs.some(p =>
                (p.kind === "pinned" || p.kind === "chokeheld") && p.role === "target");
            if (hasHardHold) {
                ui.notifications?.warn(`${this.name} can only reverse a plain grapple — a pin or chokehold has to be broken with Escape first.`);
                return null;
            }
            const holder = await fromUuid(grapplePair.partnerUuid).catch(() => null);
            if (!holder) {
                ui.notifications?.warn(`${this.name}'s grappler couldn't be resolved — try again after a token refresh.`);
                return null;
            }
            const reverserRoll = await this.rollSkill("brawling", { silent: false });
            const reverserTotal = Number(reverserRoll?.total) || 0;
            const holderRoll = await holder.rollSkill?.("brawling", { silent: false });
            const holderTotal = Number(holderRoll?.total) || 0;
            const won = reverserTotal > holderTotal;
            if (won) {
                const { reverseHold } = await import("../../mechanics/holdLink.mjs");
                await reverseHold(this, holder, "grappled");
            }
            const verdict = won
                ? `<div style="color:#4a4"><b>${esc(this.name)}</b> wrestles the dominant position — <b>${esc(holder.name)}</b> is now the one grappled.</div>`
                : `<div style="color:#a44"><b>${esc(this.name)}</b> can't turn the tables — <b>${esc(holder.name)}</b> keeps the hold.</div>`;
            await ChatMessage.create({
                speaker,
                content:
                    `<div class="wdm-attack-card">` +
                        `<b>${esc(this.name)}</b> — Reverse Grapple: <b>${reverserTotal}</b> vs ` +
                        `<b>${esc(holder.name)}</b>'s Brawling <b>${holderTotal}</b>.` +
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
                ui.notifications?.warn(`${this.name} isn't holding anyone — nothing to release.`);
                return null;
            }
            const { clearHoldLink } = await import("../../mechanics/holdLink.mjs");
            const releasedNames = [];
            for (const p of holderPairs) {
                const partner = await fromUuid(p.partnerUuid).catch(() => null);
                if (!partner) continue;
                const ok = await clearHoldLink(this, "voluntary release", partner);
                if (ok) releasedNames.push(partner.name);
            }
            const list = releasedNames.length
                ? releasedNames.join(", ")
                : "everyone they were holding";
            await ChatMessage.create({
                speaker,
                content:
                    `<div class="wdm-attack-card">` +
                        `<b>${esc(this.name)}</b> releases ${esc(list)} — the hold ends.` +
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
            if (pairs.length === 0) {
                ui.notifications?.warn(`${this.name} isn't currently held — nothing to escape.`);
                return null;
            }
            /* House rule: ONE Dodge/Escape roll clears EVERY hold — grapple,
             * pin, choke, clinch, whichever the escaper is currently in.
             * Each holder still opposes with their Brawling; the escape
             * total is compared to the HIGHEST holder roll (the strongest
             * grip decides whether the escaper slips free). Beat that one,
             * and every pair the escaper's in disappears. Lose to it, and
             * nothing changes.
             *
             * Previously each pair rolled its own escape independently and
             * cleared piecewise, so a multi-hold target had to spend an
             * action per hold to fully free themselves. Under this rule a
             * single action does the whole job. */
            const escapeRoll = await this.rollSkill("dodge", { silent: false });
            const escapeTotal = Number(escapeRoll?.total) || 0;
            const holderResults = [];
            let hardestHolderTotal = -Infinity;
            let hardestHolder = null;
            for (const pair of pairs) {
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
                /* Cascade clear — every pair the escaper is on either side
                 * of drops, and the hold-family status (grappled / pinned /
                 * chokeheld / clinched) strips from both sides of each pair
                 * as they clear. Chokehold's suffocation rider is stripped
                 * inside _doClearHoldLink alongside the pair. */
                const { clearHoldLink } = await import("../../mechanics/holdLink.mjs");
                await clearHoldLink(this, "escape");
            }
            /* Post a summary card so the table sees the outcome. */
            const holdersLine = holderResults.map(r =>
                `<div><b>${esc(r.holderName)}</b>: Brawling <b>${r.holderTotal}</b>${r.holder === hardestHolder ? " <span style='opacity:.7;'>(hardest grip)</span>" : ""}</div>`
            ).join("");
            const verdict = wonAll
                ? `<div style="color:#4a4"><b>${esc(this.name)}</b> slips free — every hold breaks.</div>`
                : `<div style="color:#a44"><b>${esc(this.name)}</b> can't break free — still held.</div>`;
            await ChatMessage.create({
                speaker,
                content: `<div class="wdm-attack-card"><b>${esc(this.name)}</b> — Escape roll: <b>${escapeTotal}</b>${holderResults.length > 1 ? ` (vs ${holderResults.length} holders — highest wins)` : ""}${holdersLine}${verdict}</div>`
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
        if (loc.mode === "random") {
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
        let grappleTargets = [...(game.user?.targets ?? [])].map(t => t.actor).filter(Boolean);
        if (grappleTargets.length === 0) {
            try {
                const { getActorTarget } = await import("../../chrome/chrome/context-menu-actor.js");
                const tokenlessTarget = await getActorTarget?.();
                if (tokenlessTarget) grappleTargets = [tokenlessTarget];
            } catch (_) { /* module not loaded — fall through with empty list */ }
        }
        /* CE Combat Extended (2026-07-03) — Trip / Disarm are grapple-
         * gated in CE (per user: "In CE, Trip and Disarm are now part
         * of grappling"). RAW leaves both as standalone actions.
         *
         * When the toggle is on AND the action is Trip / Disarm, we
         * layer `needsGrapple: true` onto meta so the existing gate
         * refuses when the attacker isn't already holding the target.
         *
         * CE Trip additionally ABSORBS old-Throw behavior when it lands
         * on the held target: double kick damage + 1d6m throw + Stun
         * save. That override drops in as an additional meta layer
         * after the grapple-prereq check confirms the target is held. */
        const _ceOn = (() => {
            try {
                // eslint-disable-next-line global-require
                return game?.settings?.get?.("witcher-ttrpg-death-march", "homebrew.extendedCombat") === true;
            } catch (_) { return false; }
        })();
        /* CE grapple-gated follow-ups. Trip, Disarm, and Ride all
         * require the attacker to already be grappling the target
         * under CE (per user spec 2026-07-03). RAW leaves all three
         * as standalone. */
        if (_ceOn && (decl.action === "trip" || decl.action === "disarm" || decl.action === "ride")) {
            meta = { ...meta, needsGrapple: true };
        }
        if (meta.needsGrapple) {
            if (grappleTargets.length === 0) {
                ui.notifications?.warn(`${L(meta.labelKey)} requires an active grapple — pick the target you're already holding.`);
                return null;
            }
            const notHeld = [];
            for (const t of grappleTargets) {
                if (!(await attackerHoldsTarget(this, t))) notHeld.push(t.name);
            }
            if (notHeld.length > 0) {
                ui.notifications?.warn(`${L(meta.labelKey)} requires an active grapple with the target${notHeld.length > 1 ? "s" : ""}: ${notHeld.join(", ")}.`);
                return null;
            }
        }
        /* CE Trip enhancement — mutates the meta so downstream damage,
         * push, and stun-save code fire the enhanced version. Applies
         * after the grapple prereq check has confirmed the target is
         * already held. */
        const ceTripEnhanced = _ceOn && decl.action === "trip"
            && grappleTargets.length > 0;
        if (ceTripEnhanced) {
            meta = {
                ...meta,
                damage:          "kick",
                noDamage:        false,
                pushBackFormula: "1d6",
                triggerStunSave: { mod: 0 }
                /* Keeps: fixedLoc: "leftLeg", status: "prone" — the
                 * "kick to the legs, they fall prone" flavor is still
                 * the core mechanic; CE just cranks the outcome. */
            };
            strikeMeta = { ...strikeMeta, dmgMult: 2 };
        }
        /* CE Disarm enhancement — meta override + post-hit rider.
         *
         * Per user CE spec: "You deal punch damage to the opponent's
         * arm and take their weapon away. You can attempt a second
         * Brawling check against DC 18 to snatch the weapon for
         * yourself. If you fail or decline to steal the weapon, it is
         * tossed 1d6 meters in a random direction."
         *
         * Mechanical shape:
         *   - Punch damage to the target's arm (fixedLoc leftArm; the
         *     side is descriptive — GM can flip via called-shot dial
         *     if needed).
         *   - Rider chat note posts after the attack card describing
         *     the DC 18 optional steal + the 1d6m toss fallback. Fully
         *     interactive buttons (roll steal / roll toss) are queued
         *     for a follow-up polish pass; the note is enough for the
         *     GM + player to resolve the outcome via a sheet-side
         *     Brawling / d6 roll. */
        const ceDisarmEnhanced = _ceOn && decl.action === "disarm"
            && grappleTargets.length > 0;
        if (ceDisarmEnhanced) {
            meta = {
                ...meta,
                damage:   "punch",
                noDamage: false,
                fixedLoc: "leftArm",
                ceDisarmRider: true    // consumed after the swing lands
            };
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
        const isOpposedAction = (isGrapple || isPlainAttack)
            && grappleTargets.length > 0;
        const opposedTarget = isOpposedAction ? grappleTargets[0] : null;

        const noteParts = [];
        if (meta.note) noteParts.push(esc(L(meta.note)));
        // Push Kick distance (RAW p.159): body/3 meters of knockback,
        // surfaced as a pre-roll note so the attacker sees the expected
        // push distance. The rider block after the hit resolution
        // actually MOVES the target's token (via pushToken() below);
        // this line is purely informational. Floor to whole metres.
        if (meta.pushBackFormula === "body/3") {
            const body = Number(this.system?.stats?.body?.value) || 0;
            const push = Math.floor(body / 3);
            if (push > 0) noteParts.push(esc(`Push back ${push}m on a successful kick.`));
        } else if (meta.pushBackFormula === "phy/5") {
            const phy = Number(this.system?.skills?.body?.physique?.value) || 0;
            const push = Math.floor(phy / 5);
            if (push > 0) noteParts.push(esc(`Push back ${push}m on a successful shove.`));
        } else if (meta.pushBackFormula === "1d6") {
            noteParts.push(esc(`Throw distance: 1d6m on a successful trip.`));
        }
        /* The grapple-chain prerequisite (needsGrapple: pin/choke/throw/
         * trip against a non-held target) is now enforced upstream —
         * the action refuses to fire and this block doesn't run. No
         * follow-up warning line needed. */
        const note = noteParts.join("<br>");

        const damage = brawlDamage(this, meta, strikeMeta);
        const types  = meta.damage ? L("WITCHER.Brawl.NonLethal") : "";
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
                    attackKind:    isGrapple ? "grapple" : "normal"
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
                return `<div class="wdm-attack-defense"><span class="wdm-attack-defense-k">Defense</span> <span class="wdm-attack-defense-v"><b>${esc(opposedTarget?.name ?? "Defender")}</b> took no defense → <b>DC 10</b></span></div>`;
            }
            if (!act || act === "none") return "";
            const label = act.charAt(0).toUpperCase() + act.slice(1);
            const totalTxt = hasDefenseTotal ? String(defenseTotal) : "—";
            return `<div class="wdm-attack-defense"><span class="wdm-attack-defense-k">Defense</span> <span class="wdm-attack-defense-v"><b>${esc(opposedTarget?.name ?? "Defender")}</b> chose <b>${esc(label)}</b> → <b>${esc(totalTxt)}</b></span></div>`;
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
            const roll = _clauseFor(id)?.mods?.roll;
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
                damage: { ...shotDamage, types, locMult, locLabel: loc.label },
                note: noteWithDefense
            });
            result = await extendedRoll(effectiveGrandMod ? `1d10 + ${effectiveGrandMod}` : `1d10`,
                { speaker, flavor, flags: { "witcher-ttrpg-death-march": { category: "combat" } } },
                { fumbleCategory: "unarmedAttack" });
            if (i === 0 && isOpposedAction) {
                const atkTotal = Number(result?.total);
                firstShotBeat = hasDefenseTotal
                    && Number.isFinite(atkTotal)
                    && atkTotal > defenseTotal;
            }
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
            if (ChatMessage?.create) {
                try {
                    await ChatMessage.create({
                        content: `<div class="wdm-attack-rider"><i class="fa-solid fa-shield"></i> <strong>${esc(opposedTarget?.name ?? "Defender")}</strong> beats the roll — the ${esc(L(meta.labelKey))} misses.</div>`,
                        speaker
                    });
                } catch (_) { /* best-effort */ }
            }
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
                        ? `<div class="wdm-attack-rider"><i class="fa-solid fa-hand-fist"></i> <strong>${esc(this.name)}</strong> beats the opposed roll (<strong>${esc(atkTxt)}</strong> vs <strong>${esc(defTxt)}</strong>) — <strong>${esc(opposedTarget.name)}</strong> is now <strong>${esc(statusLabel)}</strong>.</div>`
                        : `<div class="wdm-attack-rider"><i class="fa-solid fa-triangle-exclamation"></i> Beat the opposed roll (${esc(atkTxt)} vs ${esc(defTxt)}) but the ${esc(statusLabel)} apply failed — check tokens / adjacency.</div>`;
                } else {
                    followUpHtml = `<div class="wdm-attack-rider"><i class="fa-solid fa-shield"></i> <strong>${esc(opposedTarget?.name ?? "Target")}</strong> wins the opposed roll (<strong>${esc(atkTxt)}</strong> vs <strong>${esc(defTxt)}</strong>) — the ${esc(statusLabel)} attempt fails.</div>`;
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
            /* Post the outcome as a separate chat card so the primary
             * roll message keeps its clean rendering. Best-effort — a
             * ChatMessage.create failure just drops the follow-up. */
            if (followUpHtml && ChatMessage?.create) {
                try { await ChatMessage.create({ content: followUpHtml, speaker }); }
                catch (_) { /* ignore */ }
            }
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
                } else if (meta.pushBackFormula === "phy/5") {
                    const phy = Number(this.system?.skills?.body?.physique?.value) || 0;
                    pushM = Math.floor(phy / 5);
                } else if (meta.pushBackFormula === "1d6") {
                    const roll = await new Roll("1d6").evaluate();
                    pushM = Number(roll.total) || 0;
                }
                const attackerToken = this.getActiveTokens?.()?.[0] ?? null;
                const targetToken   = opposedTarget.getActiveTokens?.()?.[0] ?? null;
                if (pushM > 0 && attackerToken && targetToken?.document?.uuid) {
                    const sourcePoint = {
                        x: Number(attackerToken.center?.x ?? attackerToken.x),
                        y: Number(attackerToken.center?.y ?? attackerToken.y)
                    };
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
                    if (ChatMessage?.create) {
                        try { await ChatMessage.create({ content: html, speaker }); }
                        catch (_) { /* best-effort */ }
                    }
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

        /* CE Disarm rider — post-hit chat note (Phase 5).
         *
         * Fires when CE Disarm lands (attacker beat the defender's
         * check). Describes the DC 18 Brawling optional-steal + 1d6m
         * random-direction toss. The rolls themselves aren't
         * automated in this pass — the sheet's Brawling button and a
         * `/r 1d6` from chat cover them, and the GM adjudicates
         * direction on the canvas. Full interactive buttons
         * (roll-steal / roll-toss) are queued as follow-up polish. */
        if (meta.ceDisarmRider && opposedTarget && throwSucceeded && ChatMessage?.create) {
            try {
                const html =
                    `<div class="wdm-attack-rider">` +
                        `<i class="fa-solid fa-hand-fist"></i> ` +
                        `<strong>${esc(opposedTarget.name)}</strong> is disarmed — ` +
                        `the weapon flies from their hand. ` +
                        `<strong>${esc(this.name)}</strong> may attempt a ` +
                        `<strong>DC 18 Brawling</strong> check to snatch it. ` +
                        `On fail or decline the weapon tosses ` +
                        `<strong>1d6m</strong> in a random direction.` +
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
