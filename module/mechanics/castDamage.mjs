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

import { emitApplyDamage } from "../setup/socketHook.mjs";
import { appendAttackResult } from "../documents/mixins/weaponAttackMixin.mjs";

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

/** Show a small DialogV2 prompt for the per-target margin when the
 *  formula uses {margin}. Returns the picked number, or null if
 *  the user cancelled. */
async function promptMargin(targetName) {
    const DialogV2 = foundry?.applications?.api?.DialogV2;
    if (!DialogV2) return 0;
    const val = await DialogV2.prompt({
        window: { title: `Margin vs ${targetName}` },
        content: `<div style="padding:8px 0; font-size:0.8125rem;">
            <label style="display:flex; gap:10px; align-items:center;">
                <span style="min-width:80px;">Points over defense</span>
                <input type="number" name="m" min="0" step="1" value="1" autofocus />
            </label>
            <p class="hint" style="opacity:0.7; margin-top:6px;">
                Formula uses <code>{margin}</code>. Enter (attack roll − defense) — capped
                by the spell's own limit if any.
            </p>
        </div>`,
        ok: { label: "Roll", callback: (_e, b) => Number(b.form?.elements?.m?.value) || 0 },
        rejectClose: false
    }).catch(() => null);
    return val == null ? null : Number(val) || 0;
}

/** Strip the Roll Damage button + its wrapper from the cast card's
 *  content. Called once at the start of `rollAndApply` so a double-
 *  click can't fire the flow twice, and so subsequent renders don't
 *  show a stale button. Matches the melee flow's post-roll button
 *  cleanup shape (see weaponAttackMixin ~line 700). */
async function stripCastDamageButton(msg) {
    if (!msg) return;
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
        ui.notifications?.info("This cast has no damage formula to roll.");
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
                    `→ <strong>${esc(targetName)}</strong> takes <b>${total}</b>${elemLbl ? ` ${esc(elemLbl)}` : ""}` +
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
            /* Ablation — reduce SP on each equipped armor piece the
             * target carries. RAW Rusting-style: same total applies to
             * EACH armor separately, per-location. Iterates all
             * `{location}Stopping` fields and drains by the roll. */
            if (game.user?.isActiveGM || targetActor.isOwner) {
                try {
                    const worn = (targetActor.items?.contents ?? [])
                        .filter(i => i.type === "armor" && !!i.system?.equipped);
                    const LOCS = ["head", "torso", "leftArm", "rightArm", "leftLeg", "rightLeg"];
                    for (const armor of worn) {
                        const patch = {};
                        for (const loc of LOCS) {
                            const key = `${loc}Stopping`;
                            const cur = Number(armor.system?.[key]) || 0;
                            if (cur <= 0) continue;
                            const next = Math.max(0, cur - total);
                            patch[`system.${key}`] = next;
                        }
                        if (Object.keys(patch).length) await armor.update(patch);
                    }
                } catch (err) {
                    console.warn("witcher-ttrpg-death-march | ablation apply failed", err);
                }
            }
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
                        const cur = Number(item.system.reliability?.value) || 0;
                        const next = Math.max(0, cur - total);
                        await item.update({ "system.reliability.value": next });
                    }
                } catch (err) {
                    console.warn("witcher-ttrpg-death-march | reliability apply failed", err);
                }
            }
        } else if (total > 0 && type === "shieldHp") {
            /* Shield HP pool — creates an ActiveEffect on the CASTER
             * that carries `flags.witcher-ttrpg-death-march.activeShieldHp
             * = total`. The existing damage-apply pipeline in socketHook
             * already reads this flag: on ANY incoming damage the shield
             * drains first (buildActiveShield → activeShield calculator
             * stage → hp patched back to the flag). Once hp ≤ 0 the AE
             * self-deletes, matching the "shield collapses when
             * exhausted" RAW.
             *
             * Duration mirrors the spell's own duration when set (so a
             * 10-round Quen auto-expires); otherwise the AE has no
             * duration and lasts until drained. */
            const caster = castContext?.casterUuid
                ? await fromUuid(castContext.casterUuid).catch(() => null)
                : null;
            if (caster && (game.user?.isActiveGM || caster.isOwner)) {
                try {
                    const durVal = Number(castContext?.duration?.value) || 0;
                    const durUnit = String(castContext?.duration?.unit ?? "instant");
                    let aeDuration = null;
                    if (durVal > 0) {
                        if      (durUnit === "rounds")  aeDuration = { rounds: durVal };
                        else if (durUnit === "minutes") aeDuration = { seconds: durVal * 60 };
                        else if (durUnit === "hours")   aeDuration = { seconds: durVal * 3600 };
                        else if (durUnit === "days")    aeDuration = { seconds: durVal * 86400 };
                    }
                    const srcItem = castContext?.itemUuid
                        ? await fromUuid(castContext.itemUuid).catch(() => null)
                        : null;
                    await caster.createEmbeddedDocuments("ActiveEffect", [{
                        name: srcItem?.name ?? "Cast Shield",
                        img:  srcItem?.img  ?? "icons/svg/shield.svg",
                        ...(aeDuration ? { duration: aeDuration } : {}),
                        statuses: [],
                        flags: {
                            [SYSTEM_ID]: {
                                activeShieldHp: total,
                                sourceItem:     castContext?.itemUuid ?? "",
                                castShield:     true
                            }
                        }
                    }]);
                    fragments.push(
                        `<div class="wdm-attack-damage-note" style="margin-top:4px;padding:4px 6px;border:1px solid rgba(200,168,120,0.35);background:rgba(200,168,120,0.06);font-size:0.75rem;">` +
                            `<i class="fa-solid fa-shield"></i> Shield HP pool established at <strong>${total}</strong> on ${esc(caster.name)}.` +
                        `</div>`
                    );
                    summaryChips.push({ label: `Shield ${total}`, kind: "info" });
                } catch (err) {
                    console.warn("witcher-ttrpg-death-march | shield HP AE create failed", err);
                }
            }
            /* Shield HP is caster-side — break out of the per-target loop
             * to avoid creating multiple AEs when the cast has multiple
             * stamped targets. */
            break;
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
        await appendAttackResult(msg, {
            fragment:      mergedFragment,
            summaryAdd:    firstChip,
            summaryAction: ""
        });
        for (const chip of summaryChips) {
            await appendAttackResult(msg, { summaryAdd: chip });
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
            if (!formula) return;

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
            btn.innerHTML = `<i class="fa-solid fa-burst"></i> Roll Damage`;
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

            /* Slot the button into the cast card's header, below the
             * effect narrative. The wrap gives us a stable DOM handle
             * for the post-roll strip in stripCastDamageButton. */
            (el.querySelector(".wdm-cast-head") ?? el.querySelector(".message-content") ?? el).appendChild(
                (() => {
                    const wrap = document.createElement("div");
                    wrap.className = "wdm-cast-damage-wrap";
                    wrap.appendChild(btn);
                    return wrap;
                })()
            );
        } catch (err) {
            console.warn("witcher-ttrpg-death-march | cast damage render failed", err);
        }
    });
}
