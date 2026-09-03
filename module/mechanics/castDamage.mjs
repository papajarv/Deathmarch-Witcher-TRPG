/**
 * Cast card Roll Damage button — reads the castContext envelope, rolls
 * the formula with placeholder interpolation, and applies damage +
 * status riders to each stamped target.
 *
 * All output is FOLDED into the original cast chat card via
 * appendAttackResult (the same primitive the melee flow uses) so the
 * table sees one collapsible card per cast — not a cast card + a
 * separate damage roll message + a separate audit message. After a
 * click, the Roll Damage button strips from the card so the shot is
 * one-and-done.
 *
 * Placeholder syntax:
 *   {sta}    → staSpent from the envelope (per-STA scaling — Igni, Fire
 *              Stream, Quen, Active Shield)
 *   {margin} → attack roll delta vs the target's defense; since RAW
 *              cast cards don't auto-prompt defense, we ask the user
 *              for the margin at click time (Cenlly Graig, Carys' Hail,
 *              Bronwyn's Gust)
 *
 * Damage-type routing (castContext.damage.type):
 *   hp          → normal HP damage via emitApplyDamage
 *   sta         → drain target's current STA
 *   ablation    → damage worn armor SP
 *   reliability → damage weapon reliability
 *   shieldHp    → grant caster a shield HP pool (Quen / Active Shield)
 *
 * Status riders: after damage lands on each target, iterate
 * castContext.statusRiders and roll chance% per rider — hits fire
 * emitApplyStatus for the matching statusId and fold a "Status Effects"
 * block into the card with per-rider hit/miss lines.
 *
 * Owner gate: only the caster's owner (or the GM) sees the button
 * interactive; other clients see it stripped, same pattern as attack
 * damage buttons.
 */

import { emitApplyDamage, emitAppendAttackFragment } from "../setup/socketHook.mjs";
import { appendAttackResult } from "../documents/mixins/weaponAttackMixin.mjs";

import { t, tFormat } from "../chrome/lib/i18n.js";
import { durableAblationNegated } from "./durable.mjs";
const SYSTEM_ID = "witcher-ttrpg-death-march";

function esc(s) { return Handlebars.escapeExpression(String(s ?? "")); }

/** Human label for a damage element key (fire, cold, electrical …).
 *  Uses CONFIG.WITCHER.damageTypes when available so it matches the
 *  wording used everywhere else on the sheet. Falls back to the raw key. */
function elementLabel(key) {
    if (!key || key === "none") return "";
    const dt = CONFIG?.WITCHER?.damageTypes ?? {};
    const entry = dt[key];
    if (entry) {
        try { return game.i18n.localize(entry) || String(key); }
        catch (_) { /* fall through */ }
    }
    return String(key).charAt(0).toUpperCase() + String(key).slice(1);
}

/** Roll a formula string. Returns { total, formula: expanded, roll }. */
async function rollFormula(formula, rollData = {}) {
    if (!formula) return { total: 0, formula: "", roll: null };
    try {
        const roll = new Roll(String(formula), rollData);
        await roll.evaluate();
        return { total: Number(roll.total) || 0, formula: String(formula), roll };
    } catch (err) {
        console.warn(`witcher-ttrpg-death-march | cast damage roll failed for "${formula}"`, err);
        return { total: 0, formula: String(formula), roll: null };
    }
}

/** Interpolate {sta} and {margin} placeholders. `staSpent` is always
 *  available from the envelope. `margin` is prompted per-target (via
 *  the caller). Returns the substituted string. */
function interpolate(formula, { staSpent = 0, margin = 0 } = {}) {
    return String(formula)
        .replace(/\{sta\}/gi,    String(staSpent))
        .replace(/\{margin\}/gi, String(margin));
}

/** Drain `amount` armour SP from every equipped armour piece the target
 *  carries, per hit-location. RAW Rusting-style — the same amount hits each
 *  armour separately. Used by the primary damageType:"ablation" path AND the
 *  secondary ablateArmor add-on (ablate alongside HP damage). No-op for a
 *  non-positive amount or when the caller lacks permission on the target. */
async function applyArmorAblation(targetActor, amount, { locations = null } = {}) {
    if (!(amount > 0) || !targetActor) return;
    if (!(game.user?.isActiveGM || targetActor.isOwner)) return;
    try {
        const worn = (targetActor.items?.contents ?? [])
            .filter(i => i.type === "armor" && !!i.system?.equipped);
        /* `locations` null → every hit location (RAW Rusting); an array →
         * only those (hit-location-only mode). */
        const ALL  = ["head", "torso", "leftArm", "rightArm", "leftLeg", "rightLeg"];
        const LOCS = Array.isArray(locations) && locations.length ? locations : ALL;
        for (const armor of worn) {
            const patch = {};
            for (const loc of LOCS) {
                const key = `${loc}Stopping`;
                const cur = Number(armor.system?.[key]) || 0;
                if (cur <= 0) continue;
                patch[`system.${key}`] = Math.max(0, cur - amount);
            }
            if (Object.keys(patch).length) await armor.update(patch);
        }
    } catch (err) {
        console.warn("witcher-ttrpg-death-march | ablation apply failed", err);
    }
}

/** Show a small DialogV2 prompt for the per-target margin when the
 *  formula uses {margin}. Returns the picked number, or null if
 *  the user cancelled. */
async function promptMargin(targetName) {
    const DialogV2 = foundry?.applications?.api?.DialogV2;
    if (!DialogV2) return 0;
    const val = await DialogV2.prompt({
        window: { title: tFormat("WITCHER.Mech.CastDamage.Dialog.Title.MarginVsX", { targetName: targetName }, "Margin vs {targetName}") },
        content: tFormat(
            "WITCHER.Mech.CastDamage.Dialog.MarginBody",
            {
                label: t("WITCHER.Mech.CastDamage.Dialog.PointsOverDefense", "Points over defense"),
                hint:  t("WITCHER.Mech.CastDamage.Dialog.MarginHint", "Formula uses <code>{margin}</code>. Enter (attack roll − defense) — capped by the spell's own limit if any.")
            },
            "<div style=\"padding:8px 0; font-size:0.8125rem;\"><label style=\"display:flex; gap:10px; align-items:center;\"><span style=\"min-width:80px;\">{label}</span><input type=\"number\" name=\"m\" min=\"0\" step=\"1\" value=\"1\" autofocus /></label><p class=\"hint\" style=\"opacity:0.7; margin-top:6px;\">{hint}</p></div>"
        ),
        ok: { label: t("WITCHER.Common.Roll", "Roll"), callback: (_e, b) => Number(b.form?.elements?.m?.value) || 0 },
        rejectClose: false
    }).catch(() => null);
    return val == null ? null : Number(val) || 0;
}

/** Strip the Roll Damage button + its wrapper from the cast card's
 *  content. Called once at the start of `rollAndApply` so a double-
 *  click can't fire the flow twice, and so subsequent renders don't
 *  show a stale button. Matches the melee flow's post-roll button
 *  cleanup shape (see weaponAttackMixin ~line 700).
 *
 *  Skips the local update when the current user can't modify the
 *  message (default ChatMessage `update: "OWNER"` = author-only) —
 *  the caller relies on `appendAttackResult` going through the GM
 *  socket in that case, which will also clear the summary slot via
 *  `summaryAction: ""`. Without this gate the update would throw and
 *  the visible dice roll would never appear on the card for a player
 *  who owns the caster but didn't author the cast message (e.g. GM
 *  cast the spell from the dock on their behalf). */
async function stripCastDamageButton(msg) {
    if (!msg) return;
    if (!msg.canUserModify?.(game.user, "update")) return;
    try {
        const tmp = document.createElement("div");
        tmp.innerHTML = String(msg.content ?? "");
        tmp.querySelectorAll(".wdm-cast-damage-wrap").forEach(n => n.remove());
        tmp.querySelectorAll('button[data-action="wdm-cast-damage"]').forEach(n => n.remove());
        /* Also clear the summary action slot so the top-of-card chip row
         * doesn't render a stale button on re-render. Mirrors the melee
         * flow which nukes .wdm-card-sum-roll + the stored data attr. */
        tmp.querySelectorAll(".wdm-card-sum-roll").forEach(n => n.remove());
        tmp.querySelectorAll("details.wdm-attack-card").forEach(c => {
            delete c.dataset.summaryActionHtml;
        });
        await msg.update({ content: tmp.innerHTML });
    } catch (err) {
        console.warn("witcher-ttrpg-death-march | strip cast damage button failed", err);
    }
}

/** Build the damage-block fragment for a single target — a header, the
 *  optional per-STA / margin annotation, and the dice tray. Mirrors the
 *  shape of the melee damage block (`.wdm-attack-damage-roll-block`) so
 *  the two cards look the same. */
async function buildDamageFragment({ head, subhead, roll }) {
    const diceHtml = roll ? await roll.render() : "";
    const subLine = subhead
        ? `<div class="wdm-attack-damage-note" style="opacity:0.75;">${esc(subhead)}</div>`
        : "";
    return `<div class="wdm-attack-damage-roll-block">` +
                `<div class="wdm-attack-damage-roll-head">${esc(head)}</div>` +
                subLine +
                diceHtml +
           `</div>`;
}

/** Fire the button's actual work — one roll per target, damage applied.
 *  Called from the click handler. Status riders auto-apply at CAST time
 *  in castSpellMixin, not here (moved so no-damage spells still apply). */
async function rollAndApply(castContext, msg) {
    const dmg      = castContext?.damage ?? {};
    const formula  = String(dmg.formula ?? "").trim();
    const element  = String(dmg.element ?? "none");
    const type     = String(dmg.type    ?? "none");
    const staSpent = Number(castContext?.staSpent) || 0;
    /* Spell-level tangibility — TRUE means Active Shield / Quen drains
     * HP damage first AND absorbs any status riders on this cast.
     * FALSE (suffocation, noxious fumes, mental effects) bypasses the
     * shield entirely on both axes. Default TRUE if the envelope
     * doesn't carry the field (legacy casts / older messages). */
    const tangible = castContext?.tangible !== false;
    const targets  = Array.isArray(castContext?.targets) && castContext.targets.length
        ? castContext.targets
        : [{ uuid: null, defenseTotal: null, hit: null }];

    if (!formula) {
        ui.notifications?.info(t("WITCHER.Mech.CastDamage.Notify.ThisCastHasNoDamageFormula", "This cast has no damage formula to roll."));
        return;
    }
    const usesMargin = /\{margin\}/i.test(formula);
    const elemLbl = elementLabel(element);

    /* Strip the button up front so a mid-roll re-render can't clone
     * an interactive copy. Melee does the strip AFTER — we do it BEFORE
     * because cast rolling is async (per-target damage-apply socket
     * round-trips), and a second click during that window would double-
     * spend. */
    await stripCastDamageButton(msg);

    /* Collected across all targets, then folded into the ORIGINAL cast
     * card in one appendAttackResult call so the whole resolution
     * lives on one collapsible. Summary chips (per-target damage,
     * per-rider apply) get pushed via successive calls. */
    const fragments = [];
    const summaryChips = [];

    /* RAW AoE: a spell whose damage formula doesn't scale by {margin}
     * rolls ONCE and every target takes the SAME rolled total. Each
     * target's own SP / DR / natural resists still filter the incoming
     * hit downstream via emitApplyDamage, so an armored target still
     * takes less than a naked one — the shared roll is only the PRE-
     * filter number. Formulas that DO use {margin} keep per-target
     * rolls: margin is (castTotal − target.defenseTotal), a per-
     * defender quantity that can't be shared. */
    let sharedRoll  = null;
    let sharedTotal = 0;
    if (!usesMargin) {
        const hitTargetCount = targets.filter(t => t?.hit !== false && t?.uuid).length;
        if (hitTargetCount > 0) {
            const expanded = interpolate(formula, { staSpent, margin: 0 });
            const rolled = await rollFormula(expanded);
            sharedRoll  = rolled.roll;
            sharedTotal = rolled.total;
            const head = `Cast Damage${elemLbl ? ` — ${elemLbl}` : ""}${hitTargetCount > 1 ? " (AoE)" : ""}`;
            const subParts = [];
            if (staSpent && /\{sta\}/i.test(formula)) subParts.push(`${staSpent} STA`);
            const subhead = subParts.length ? subParts.join(" · ") : "";
            if (sharedRoll) fragments.push(await buildDamageFragment({ head, subhead, roll: sharedRoll }));
            if (sharedTotal > 0) {
                const chipLabel = elemLbl ? `${sharedTotal} ${elemLbl}` : `${sharedTotal} dmg`;
                summaryChips.push({ label: chipLabel, kind: "damage" });
            }
        }
    }

    for (const t of targets) {
        /* Verdict gate — skip targets that missed. `hit === false` is
         * an explicit MISS from the verdict fan-out in castSpellMixin;
         * `hit === null` (unresolved: no defense clause, self-cast,
         * or a legacy card) falls through so the cast still lands. */
        if (t?.hit === false) continue;
        const targetActor = t?.uuid ? await fromUuid(t.uuid).catch(() => null) : null;
        const targetName = targetActor?.name ?? "target";

        /* Per-target roll ONLY for margin formulas; AoE shared-roll
         * casts reuse `sharedTotal` (rolled once above) and skip
         * re-rendering the dice tray per target. */
        let margin = 0;
        let total  = sharedTotal;
        if (usesMargin) {
            /* Resolve {margin} — cast delta from the verdict fan-out
             * (castTotal − t.defenseTotal). Prompts when the envelope
             * doesn't carry the numbers (self-casts, legacy cards,
             * non-defensible targets). */
            const knownDelta = (Number.isFinite(castContext?.castTotal) && Number.isFinite(t?.defenseTotal))
                ? Math.max(0, castContext.castTotal - t.defenseTotal)
                : null;
            if (knownDelta != null) {
                margin = knownDelta;
            } else {
                const picked = await promptMargin(targetName);
                if (picked == null) continue;   // user cancelled this target
                margin = picked;
            }
            const expanded = interpolate(formula, { staSpent, margin });
            const rolled = await rollFormula(expanded);
            total = rolled.total;

            const head = `Cast Damage${elemLbl ? ` — ${elemLbl}` : ""}` +
                         (targetName !== "target" ? ` · ${targetName}` : "");
            const subParts = [];
            if (staSpent && /\{sta\}/i.test(formula)) subParts.push(`${staSpent} STA`);
            subParts.push(`margin ${margin}`);
            const subhead = subParts.join(" · ");
            if (rolled.roll) {
                fragments.push(await buildDamageFragment({ head, subhead, roll: rolled.roll }));
            }
            if (total > 0) {
                const chipLabel = elemLbl ? `${total} ${elemLbl}` : `${total} dmg`;
                summaryChips.push({ label: chipLabel, kind: "damage" });
            }
        } else if (total > 0 && targetActor) {
            /* AoE shared-roll case: a compact per-target application line
             * so the reader sees who takes the shared hit without a
             * second dice tray. Actual filtered damage after SP/DR is
             * still resolved downstream by the damage calculator. */
            fragments.push(
                `<div class="wdm-cast-damage-per-target" style="font-size:0.8125rem;padding:2px 8px;opacity:0.9;">` +
                    tFormat("WITCHER.Mech.CastDamage.Text.TargetTakes", { target: esc(targetName), total, elem: elemLbl ? ` ${esc(elemLbl)}` : "" }, `→ <strong>${esc(targetName)}</strong> takes <b>${total}</b>${elemLbl ? ` ${esc(elemLbl)}` : ""}`) +
                `</div>`
            );
        }

        /* Damage-type dispatch. Each branch writes to the correct target
         * axis. shieldHp is the exception — it stamps on the CASTER, not
         * the target (Quen, Active Shield grant the caster protection). */
        if (total > 0 && (type === "hp" || type === "none") && targetActor) {
            /* Normal HP path — routes through the damage calculator so
             * SP + DR + immunity all resolve properly. */
            try {
                await emitApplyDamage({
                    targetUuid:        targetActor.uuid,
                    weaponDamage:      total,
                    silverDamage:      0,
                    damageTypes:       element === "none" ? [] : [element],
                    locationKey:       "torso",
                    locationLabel:     "Torso",
                    qualities:         [],
                    qualityValues:     {},
                    critSeverity:      null,
                    weaponUuid:        castContext?.itemUuid ?? "",
                    attackMessageUuid: msg?.uuid ?? null,
                    /* Bypass Armor (schema `bypassArmor`) → throughArmor: damage
                     * skips SP entirely. Active Shield / Quen still drain per
                     * `tangible`. Was previously wired only on the periodic path. */
                    throughArmor:      !!castContext?.damage?.bypassArmor,
                    /* Tangibility forwards to the damage calculator (`src.tangible`)
                     * which decides whether Active Shield drains. Intangible
                     * casts skip Stage 2 entirely — damage lands on HP. */
                    tangible:          tangible
                });
            } catch (err) {
                console.warn("witcher-ttrpg-death-march | cast HP damage apply failed", err);
            }
        } else if (total > 0 && type === "sta" && targetActor) {
            /* STA drain (Blaze of Korath, Light of Penance, Suffocate,
             * Ainfra's Extraction). spendStamina clamps at 0 and fires
             * downstream hooks (satiety burn, 0-STA stun). Must be the
             * target's owner OR GM to succeed. */
            if (typeof targetActor.spendStamina === "function") {
                try {
                    if (game.user?.isActiveGM || targetActor.isOwner) {
                        await targetActor.spendStamina(total, { reason: "castSta" });
                    }
                } catch (err) {
                    console.warn("witcher-ttrpg-death-march | STA drain failed", err);
                }
            }
        } else if (total > 0 && type === "ablation" && targetActor) {
            /* Ablation — reduce SP on each equipped armor piece the target
             * carries. Every location (RAW Rusting) or only the struck one
             * (torso for casts) per the ablateHitLocationOnly toggle. */
            const _abLocs = castContext?.damage?.ablateHitLocationOnly ? ["torso"] : null;
            await applyArmorAblation(targetActor, total, { locations: _abLocs });
        } else if (total > 0 && type === "reliability" && targetActor) {
            /* Weapon reliability drain — reduce every equipped weapon's
             * `system.reliability.value` by the roll. Shields get hit
             * too (they use the same reliability shape). Feeds Rusting
             * (weapon mode) and Smith's Touch (weapon mode). */
            if (game.user?.isActiveGM || targetActor.isOwner) {
                try {
                    const equipped = (targetActor.items?.contents ?? [])
                        .filter(i => (i.type === "weapon" || i.type === "shield")
                                     && !!i.system?.equipped
                                     && Number(i.system?.reliability?.value) > 0);
                    for (const item of equipped) {
                        if (await durableAblationNegated(item, { actor: targetActor })) continue;   // Durable rune save
                        const cur = Number(item.system.reliability?.value) || 0;
                        const next = Math.max(0, cur - total);
                        await item.update({ "system.reliability.value": next });
                    }
                } catch (err) {
                    console.warn("witcher-ttrpg-death-march | reliability apply failed", err);
                }
            }
        } else if (total > 0 && type === "shieldHp") {
            /* Shield HP is applied at CAST TIME by castSpellMixin now
             * (deterministic hpPerSta × sta, take-higher refill on
             * recast, single AE badge + system.derivedStats.shield).
             * The old damage-button path required a rolled formula and
             * created a stacking AE per cast — Quen items with no
             * formula never applied at all. This branch is intentionally
             * a no-op; kept for the type-dispatch shape only. */
            continue;   // skip THIS target only — `break` truncated the whole loop
        }

        /* Secondary armour ablation — applied ALONGSIDE the main damage
         * (acid bolt: HP damage AND rust armour), independent of the primary
         * damageType. Rolled per target. Skipped when the primary type is
         * already "ablation" (that path ablates on its own) so it can't
         * double-dip. */
        const _ablateExpr = String(castContext?.damage?.ablateArmor ?? "").trim();
        if (_ablateExpr && targetActor && type !== "ablation") {
            try {
                const staSpent = Number(castContext?.staSpent) || 0;
                /* Use THIS target's margin so `{margin}` in the ablate formula
                 * scales like the main damage does (was hard-coded to 0). */
                const { total: _abl } = await rollFormula(interpolate(_ablateExpr, { staSpent, margin }));
                const _abLocs = castContext?.damage?.ablateHitLocationOnly ? ["torso"] : null;
                await applyArmorAblation(targetActor, Math.max(0, Math.floor(_abl)), { locations: _abLocs });
            } catch (err) {
                console.warn("witcher-ttrpg-death-march | secondary ablation failed", err);
            }
        }

        /* Status riders are auto-applied at CAST time by castSpellMixin
         * (post-verdict), not damage-button time — moved so spells
         * with no damage formula (Aard's knockdown, Yrden's paralysis)
         * still land their effects. This loop stays damage-only. */
    }

    /* Fold everything into the ORIGINAL cast card. First call carries
     * the merged fragment + the first summary chip; subsequent chips go
     * through their own no-fragment calls so appendAttackResult can
     * push them onto the summary list in order. `summaryAction: ""`
     * clears any lingering summary-slot button HTML from the melee
     * summary rail (defense in-depth — the DOM strip above should have
     * killed it already). */
    if (fragments.length || summaryChips.length) {
        const mergedFragment = fragments.join("");
        const firstChip = summaryChips.shift() ?? "";
        /* Route through the GM socket when the current user can't
         * update the cast message (default ChatMessage permissions:
         * author-only). Without this, non-author owners of the caster
         * would see their click do nothing — the local msg.update
         * inside appendAttackResult throws silently. See the melee
         * fix in weaponAttackMixin `rollDamageFromButton`. */
        const canModifyMsg = !!msg?.canUserModify?.(game.user, "update");
        if (canModifyMsg) {
            await appendAttackResult(msg, {
                fragment:      mergedFragment,
                summaryAdd:    firstChip,
                summaryAction: ""
            });
            for (const chip of summaryChips) {
                await appendAttackResult(msg, { summaryAdd: chip });
            }
        } else {
            await emitAppendAttackFragment({
                attackMessageUuid: msg.uuid,
                fragment:          mergedFragment,
                summaryAdd:        firstChip || null,
                summaryAction:     ""
            });
            for (const chip of summaryChips) {
                await emitAppendAttackFragment({
                    attackMessageUuid: msg.uuid,
                    summaryAdd:        chip
                });
            }
        }
    }
}

/** Install the render hook that injects the Roll Damage button on
 *  cast cards whose castContext carries a formula. Idempotent per
 *  card via a DOM marker. Ownership check gates non-owners. */
export function installCastDamageHandler() {
    Hooks.on("renderChatMessageHTML", async (msg, el) => {
        try {
            const castContext = msg?.getFlag?.(SYSTEM_ID, "castContext");
            if (!castContext) return;
            const formula = String(castContext?.damage?.formula ?? "").trim();
            /* Show the button when there's main damage OR a secondary armour
             * ablation to apply — a pure-ablate spell (ablateArmor set, no main
             * formula) still needs the button so its ablation lands. */
            const ablateOnly = String(castContext?.damage?.ablateArmor ?? "").trim();
            if (!formula && !ablateOnly) return;

            /* Shield HP spells (Quen, Active Shield, etc.) skip the button
             * entirely. Their pool is applied deterministically at cast
             * time by castSpellMixin (`hpPerSta × staSpent` — see
             * castSpellMixin.mjs:1275-1320), so there's nothing for a
             * Roll Damage click to do. Leaving the button in place made
             * players click it expecting a roll and then hit an empty
             * pipeline (shieldHp branch in `rollAndApply` at line ~368
             * intentionally does nothing here). */
            /* Heal HP applies deterministically at cast time too
             * (castSpellMixin heals each target on cast), so — like shieldHp
             * — there's nothing for a Roll Damage click to do. */
            const _ccType = String(castContext?.damage?.type);
            if (_ccType === "shieldHp" || _ccType === "healHp") return;
            /* Periodic ("Apply Every") casts tick via a synthesized AE at
             * cast time — a one-shot Roll Damage click would double-apply,
             * so suppress the button for them. */
            if (String(castContext?.damage?.applyEvery ?? "instant") !== "instant") return;

            /* Verdict gate — only enable Roll Damage on HIT. When the
             * verdict is MISS (defender resisted), the button doesn't
             * inject. When there's no verdict yet (self-cast, no target,
             * or defense clause is empty), fall through and inject —
             * the caster / GM can still roll damage for those. */
            const verdict = msg?.getFlag?.(SYSTEM_ID, "castVerdict");
            if (verdict === "miss") return;

            /* Skip if already injected OR the button was already stripped
             * (a previous click ran rollAndApply and folded the results
             * — no button on the message means the shot is spent). Both
             * checks look at the current DOM state of the message. */
            if (el.querySelector?.('button[data-action="wdm-cast-damage"]')) return;
            if (el.querySelector?.(".wdm-attack-damage-roll-block[data-cast-damage='1']")) return;
            /* If the persisted content already dropped the wrap (a
             * previous click already stripped it and folded results),
             * don't re-inject on subsequent renders. */
            if (msg?.getFlag?.(SYSTEM_ID, "castDamageRolled")) return;

            /* Owner gate — only the caster's owner (or GM) sees the
             * button interactive. Non-owners get it stripped so they
             * can't roll someone else's damage. */
            const caster = castContext.casterUuid
                ? await fromUuid(castContext.casterUuid).catch(() => null)
                : null;
            const isOwner = !!caster?.isOwner;
            const isGM    = !!game.user?.isGM;
            if (!isOwner && !isGM) return;

            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "wdm-attack-damage-roll wdm-cast-damage-btn";
            btn.dataset.action = "wdm-cast-damage";
            btn.innerHTML = `<i class="fa-solid fa-burst"></i> ${t("WITCHER.Mech.CastDamage.Text.RollDamage", "Roll Damage")}`;
            btn.addEventListener("click", async (ev) => {
                ev.stopPropagation();
                if (btn.dataset.consumed === "1") return;
                btn.dataset.consumed = "1";
                btn.disabled = true;
                /* Read the freshest envelope at click time — a Combat
                 * Meditation rider may have added damage since the
                 * card was first rendered. */
                const fresh = msg.getFlag(SYSTEM_ID, "castContext") ?? castContext;
                try {
                    await rollAndApply(fresh, msg);
                    /* Mark the message so re-renders don't re-inject
                     * a button. Persists past reloads — the button is
                     * one-shot per cast. */
                    try { await msg.setFlag(SYSTEM_ID, "castDamageRolled", true); }
                    catch (_) { /* best-effort */ }
                } catch (err) {
                    console.warn("witcher-ttrpg-death-march | cast damage handler failed", err);
                    btn.disabled = false;
                    btn.dataset.consumed = "0";
                }
            });

            /* Slot the button into the card HEADER — the collapsed summary
             * when there is one.
             *
             * `.wdm-cast-head` is the head of the cast NARRATIVE, and the
             * moment a resolution is appended the whole thing gets wrapped
             * into a `details.wdm-attack-card` that starts CLOSED — which put
             * the head, and this button with it, inside the collapsed body.
             * The next thing the caster is meant to click was reachable only
             * by expanding the card first. Melee never had that problem
             * because it hoists its Roll Damage into the summary's action
             * slot; casts now use the same slot, so the two cards behave
             * alike. `stripCastDamageButton` already removes
             * `.wdm-card-sum-roll`, so the post-roll cleanup needs no change.
             *
             * Falls back to the narrative head for a card that has not been
             * wrapped yet (no resolution appended), and to the message content
             * if even that is absent. */
            const summary = el.querySelector?.("details.wdm-attack-card > summary.wdm-attack-card-summary");
            if (summary) {
                /* Straight into the slot, no wrapper — the slot is a flex row
                 * and `.wdm-card-sum-action button` is what the header styling
                 * selects, so the button sits exactly where melee's does.
                 * `.wdm-card-sum-roll` is the class the strip already looks
                 * for. */
                btn.classList.add("wdm-card-sum-roll");
                let slot = summary.querySelector(".wdm-card-sum-action");
                if (!slot) {
                    slot = document.createElement("span");
                    slot.className = "wdm-card-sum-action";
                    summary.appendChild(slot);
                }
                slot.appendChild(btn);
            } else {
                /* Unwrapped card (no resolution appended yet): the narrative
                 * head IS the header, and the block wrap is what its styling
                 * expects. */
                const wrap = document.createElement("div");
                wrap.className = "wdm-cast-damage-wrap";
                wrap.appendChild(btn);
                (el.querySelector(".wdm-cast-head") ?? el.querySelector(".message-content") ?? el)
                    .appendChild(wrap);
            }
        } catch (err) {
            console.warn("witcher-ttrpg-death-march | cast damage render failed", err);
        }
    });
}
