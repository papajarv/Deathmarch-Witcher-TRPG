/**
 * defenseMixin — actor methods for defending with a weapon or shield.
 *
 * Composed onto WitcherActor in documents/actor.mjs. Exposes:
 *   actor.defendWith(item, mode)        — Parry (−3) or Block (no penalty)
 *   actor.defendBySkill(skill, {label}) — Dodge or Reposition
 *
 * The four defensive reactions — Reposition, Dodge, Parry, Block — all go
 * through the defense reaction economy (`recordDefense` — first free, each
 * extra costs 1 STA, Core p.152). Parry/Block roll the wielding item's skill
 * (a shield's `skillKey` is "melee"; a weapon rolls its own); Dodge rolls the
 * Dodge/Escape skill and Reposition the Athletics skill.
 *
 *   PARRY  rolls at −3 and, on the chat card, offers "Apply Stagger" — a
 *          successful parry leaves the attacker Staggered. Parry does NOT
 *          erode the item.
 *   BLOCK  rolls at no penalty and, on the chat card, offers a button that
 *          spends one point of the item's Reliability ("SP") per click —
 *          each block absorbed degrades the weapon / shield (Core p.78).
 *
 * The buttons live in the roll's flavor (extendedRoll posts content = flavor
 * + body), so they ride along on the same chat card as the defense roll.
 */

import { extendedRoll } from "../../rolls/extendedRoll.mjs";
import { getActiveWeaponQualities, getActiveArmorQualities, WEAPON_QUALITIES, ARMOR_QUALITIES, equippedArmorHasQualityLabeled } from "../../setup/config.mjs";
import { durableAblationNegated } from "../../mechanics/durable.mjs";
import { guardOf, guardDefenseMod } from "../../data/combatExtended/guards.mjs";
import { hasWRPerk } from "../../api/witcherReborn.mjs";

/* Sum the parryPenaltyDelta from every quality the given weapon/shield
 * carries (Parrying = 2, GM-authored qualities can stack). Reads the
 * active catalog so an Edit Qualities tweak takes effect without a
 * code change.
 *
 * Shields fold in too: the `parryingShield` armor-quality entry
 * declares `parryPenaltyDelta: 3` (reduces the −3 parry penalty to 0).
 * Pulls from the armor catalog when the item is a shield, weapon
 * catalog when it's a weapon. Returns 0 for non-handed items. */
function weaponParryPenaltyDelta(item) {
    if (!item) return 0;
    if (item.type !== "weapon" && item.type !== "shield") return 0;
    const cat = item.type === "shield"
        ? (getActiveArmorQualities?.() ?? ARMOR_QUALITIES)
        : (getActiveWeaponQualities?.() ?? WEAPON_QUALITIES);
    const qs = item.system?.effective?.qualities ?? item.system?.qualities ?? [];
    let delta = 0;
    for (const q of qs) {
        delta += Number(cat[q]?.parryPenaltyDelta) || 0;
    }
    return delta;
}

/* Warded (armor) — +2 to a spell defence roll from the defender's equipped
 * armor. Matched by label so a custom OR built-in quality works. */
function wardedSpellDefenseBonus(actor) {
    return equippedArmorHasQualityLabeled(actor, "Warded") ? 2 : 0;
}

/* ── EO weapon-quality readers ────────────────────────────────────────
 * Sum / OR the relevant EO fields across a weapon or shield's active
 * qualities. Each reader is defensive: missing weapon, missing qualities
 * array, unknown quality keys → 0 / false. */
function itemQualities(item) {
    if (!item) return { cat: {}, keys: [] };
    const cat = getActiveWeaponQualities?.() ?? WEAPON_QUALITIES;
    const keys = item.system?.effective?.qualities ?? item.system?.qualities ?? [];
    return { cat, keys };
}
/* +1 for Guard, +2 for Superior Guard, summed across the wielded item's
 * qualities. Applied to Block / Parry rolls only (EO p.7). */
function weaponGuardBonus(item) {
    const { cat, keys } = itemQualities(item);
    let sum = 0;
    for (const q of keys) sum += Number(cat[q]?.defenseBonus) || 0;
    return sum;
}
/* -N from Indirect when DEFENDING with the weapon. The attacker-side
 * application happens on the attack pipeline (defendingAgainstIndirect). */
function weaponIndirectSelfPenalty(item) {
    const { cat, keys } = itemQualities(item);
    let pen = 0;
    for (const q of keys) {
        if (cat[q]?.defensePenaltyBothSides) pen -= Number(cat[q].defensePenaltyBothSides) || 0;
    }
    return pen;
}
/* True if the wielded item carries Feeble → parry restricted to other
 * Feeble weapons (EO p.7). */
function weaponIsFeeble(item) {
    const { cat, keys } = itemQualities(item);
    return keys.some(q => cat[q]?.feebleParryRestrictedToFeeble);
}
/* True if the item carries Sturdy / Very Sturdy → can parry/block
 * Hefty without restriction. Shield-side qualities (sturdyShield /
 * verySturdy) live in ARMOR_QUALITIES; this reader unions both catalogs
 * by checking the weaponQualities + armorQualities entries (the union
 * map is what active items end up with via the qualities editor's
 * normalisation). */
function itemCanCounterHefty(item) {
    if (!item) return false;
    const allCat = { ...(getActiveWeaponQualities?.() ?? WEAPON_QUALITIES), ...ARMOR_QUALITIES };
    const keys = item.system?.effective?.qualities ?? item.system?.qualities ?? [];
    return keys.some(q => allCat[q]?.counterHefty);
}
import { defenseMod as statusDefenseMod, cannotDefend } from "../../mechanics/statusEngine.mjs";
import { isCombatExtendedEnabled } from "../../api/homebrew.mjs";
import { contextualPhysicalMod, contextualPhysicalChip } from "../../mechanics/holdModifiers.mjs";
import { emitApplyStatus } from "../../setup/socketHook.mjs";

import { t, tFormat } from "../../chrome/lib/i18n.js";
import { getActiveWeatherModifiers } from "../../mechanics/weather-modifiers.mjs";
const SYSTEM_ID = "witcher-ttrpg-death-march";

/* Light-level DEFENSE penalty (Darkness −2) read from the DEFENDER's own tile;
 * already waived by the defender's Dark Vision (the records are token-scoped).
 * A flat number folded into the defense total + shown as a chip. */
function lightDefenseMod(actor) {
    let mods = [];
    const token = actor?.getActiveTokens?.()?.[0] ?? null;
    try { mods = getActiveWeatherModifiers(undefined, token) ?? []; } catch (_) { mods = []; }
    return mods.filter(m => m.target === "defense").reduce((s, m) => s + (Number(m.value) || 0), 0);
}

/** Find the attack chat message linked to this defense via the engagement
 *  flag.  Returns `{ attackTotal, attackerActor }` — both can be null if no
 *  link exists (defender used a dock button outside an engagement, or the
 *  attack predates the linkage). */
function lookupEngagement(engagementId) {
    if (!engagementId || !globalThis.game?.messages) return { attackTotal: null, attackerActor: null };
    for (const msg of game.messages) {
        if (msg.getFlag?.(SYSTEM_ID, "engagementId") !== engagementId) continue;
        // Only the attack message stamps `attackTotal` — defense msgs stamp
        // `defenseTotal`. Discriminating on which flag is present picks the right one.
        const at = msg.getFlag(SYSTEM_ID, "attackTotal");
        if (at == null) continue;
        // Resolve the speaker → actor for the auto-status apply.
        const sp = msg.speaker;
        const actor = sp?.actor ? game.actors?.get?.(sp.actor)
                    : sp?.token ? game.scenes?.get?.(sp.scene)?.tokens?.get?.(sp.token)?.actor
                    : null;
        return { attackTotal: Number(at), attackerActor: actor ?? null };
    }
    return { attackTotal: null, attackerActor: null };
}

/* Build the flag payload that links a defense roll to its attack. The
 * attacker's damage button reads `defenseTotal` off the matching message
 * (matched by `engagementId`) to compute the attack-vs-defense delta for
 * crit detection. Also stamps the chat-filter category so defense rolls
 * land in Combat Logs. No-op (returns just the category) when engagementId
 * is empty (e.g. dock Dodge button outside an engagement). */
function engagementFlags(engagementId, defenseTotal) {
    const base = { category: "combat" };
    if (!engagementId) return { [SYSTEM_ID]: base };
    return { [SYSTEM_ID]: { ...base, engagementId, defenseTotal: Number(defenseTotal) || 0 } };
}

const esc = (s) => Handlebars.escapeExpression(String(s ?? ""));
const signed = (n) => `${n >= 0 ? "+" : ""}${n}`;

/** Localize a stat label, falling back to the upper-cased key when the i18n
 *  key is missing (mirrors the helper in skillMixin). */
function statName(statKey) {
    const key = String(statKey ?? "").toLowerCase();
    const out = game.i18n.localize(CONFIG.WITCHER.statLabel(key));
    return (!out || out.startsWith("WITCHER.")) ? key.toUpperCase() : out;
}

/** Header for a defense chat card — mirrors the skill/save header so all
 *  three read alike. */
function defenseFlavor({ actorName, title, subtitle, chips = [] }) {
    const chipHtml = chips
        .filter(c => c && c.value != null && c.value !== "")
        .map(c => `<span class="wdm-chip"><span class="wdm-chip-k">${esc(c.label)}</span><span class="wdm-chip-v">${esc(c.value)}</span></span>`)
        .join("");
    return `
        <div class="wdm-skill-head">
            <div class="wdm-skill-actor">${esc(actorName)}</div>
            <div class="wdm-skill-name">${esc(title)}</div>
            ${subtitle ? `<div class="wdm-skill-sub">${esc(subtitle)}</div>` : ""}
            ${chipHtml ? `<div class="wdm-skill-chips">${chipHtml}</div>` : ""}
        </div>`;
}

/** The Block action button — spends one Reliability point per click. */
function blockButtonHtml(item) {
    return `<div class="wdm-defense-actions">
        <button type="button" class="wdm-defense-btn" data-action="wdm-reduce-reliability"
                data-item-uuid="${esc(item.uuid)}">
            <i class="fa-solid fa-shield-halved"></i>
            Block absorbed — spend 1 SP (${esc(item.name)})
        </button>
    </div>`;
}


/** Equipped weapons/shields (with an SP pool) whose actor the current user
 *  controls, for the GM's Block target picker. Scopes to the GM's selected
 *  tokens + the defender from the card, falling back to every owned actor.
 *  `preselect` (the item that actually defended) is always included first. */
function reliabilityCandidates(preselect) {
    const pool = new Set();
    for (const t of canvas?.tokens?.controlled ?? []) {
        if (t.actor?.isOwner) pool.add(t.actor);
    }
    if (preselect?.actor?.isOwner) pool.add(preselect.actor);
    if (!pool.size) {
        for (const a of game.actors ?? []) if (a.isOwner) pool.add(a);
    }
    const items = [];
    for (const a of pool) {
        for (const it of a.items) {
            if ((it.type === "weapon" || it.type === "shield")
                && it.system?.equipped
                && (Number(it.system?.reliability?.max) || 0) > 0) {
                items.push(it);
            }
        }
    }
    if (preselect && !items.includes(preselect)) items.unshift(preselect);
    return items;
}

/** Dropdown to choose which equipped weapon/shield ate the block. Pre-selects
 *  the defending item. Returns the chosen item, or null on cancel. */
async function pickReliabilityItem(items, preselect) {
    const DialogV2 = foundry?.applications?.api?.DialogV2;
    if (!DialogV2) return preselect ?? items[0] ?? null;
    const opts = items.map(it => {
        const sp  = `${Number(it.system?.reliability?.value) || 0}/${Number(it.system?.reliability?.max) || 0}`;
        const sel = it === preselect ? "selected" : "";
        return `<option value="${esc(it.uuid)}" ${sel}>${esc(it.actor?.name ?? "")} — ${esc(it.name)} (SP ${sp})</option>`;
    }).join("");
    let chosen;
    try {
        chosen = await DialogV2.prompt({
            window: { title: t("WITCHER.Doc.DefenseMixin.Dialog.Title.BlockReduceWhichSP", "Block — reduce which SP?") },
            modal: true,
            content: `<div style="padding:8px 0;display:flex;flex-direction:column;gap:10px;">
                <label style="display:flex;gap:10px;align-items:center;">
                  <span style="min-width:60px;">${t("WITCHER.Doc.DefenseMixin.Text.Item", "Item")}</span>
                  <select name="uuid" autofocus style="flex:1;">${opts}</select>
                </label>
                <p style="margin:0;font-size:0.6875rem;opacity:0.7;">${t("WITCHER.Doc.DefenseMixin.Text.SpendsReliability", "Spends 1 point of the chosen weapon / shield's Reliability.")}</p>
              </div>`,
            ok: { callback: (event, button) => button.form.elements.uuid.value },
            rejectClose: true
        });
    } catch (e) { return null; }                       // cancelled
    if (!chosen) return null;
    return await fromUuid(chosen);
}

/** Spend one point of a weapon/shield's Reliability ("SP"), floored at 0. The
 *  GM gets a dropdown to route the loss to whichever of their monsters blocked
 *  (defaulting to the defending item); a player can only ever degrade their own
 *  defending item — the `isOwner` gate enforces it. */
async function reduceReliabilityFromButton(btn) {
    const uuid = btn?.dataset?.itemUuid;
    const cardItem = uuid ? await fromUuid(uuid) : null;

    let item = cardItem;
    if (game.user.isGM) {
        const candidates = reliabilityCandidates(cardItem);
        if (candidates.length > 1) {
            item = await pickReliabilityItem(candidates, cardItem);
            if (!item) return;                          // cancelled the picker
        } else if (candidates.length === 1) {
            item = candidates[0];
        }
    }
    if (!item) { ui.notifications?.warn(t("WITCHER.Doc.DefenseMixin.Notify.NoWeaponOrShieldToReduce", "No weapon or shield to reduce.")); return; }
    if (!item.isOwner) { ui.notifications?.warn(t("WITCHER.Doc.DefenseMixin.Notify.DontOwnItem", "You don't own that item.")); return; }
    const cur = Number(item.system?.reliability?.value) || 0;
    if (cur <= 0) {
        ui.notifications?.warn(tFormat("WITCHER.Doc.DefenseMixin.Notify.NoReliability", { item: item.name }, "{item} has no Reliability left — it's broken."));
        return;
    }
    if (await durableAblationNegated(item, { actor: item.actor })) return;   // Durable rune save
    const next = Math.max(0, cur - 1);
    await item.update({ "system.reliability.value": next });
    const broke = next === 0;
    await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor: item.actor }),
        content: tFormat(
            "WITCHER.Doc.DefenseMixin.Chat.BlockAbsorb",
            { item: esc(item.name), cur, next, broke: broke ? t("WITCHER.Doc.DefenseMixin.Chat.Breaks", " <strong>(breaks!)</strong>") : "" },
            "<em>{item} absorbs a block — SP {cur} → {next}{broke}.</em>"
        ),
        flags: { [SYSTEM_ID]: { category: "combat" } }
    });
}

/** Wire the defense-card action buttons. Called once during setup. */
export function installDefenseChatHandlers() {
    Hooks.on("renderChatMessageHTML", (_msg, el) => {
        const block = el.querySelector?.('button[data-action="wdm-reduce-reliability"]');
        if (block && !block.dataset.wired) {
            block.dataset.wired = "1";
            block.addEventListener("click", () => reduceReliabilityFromButton(block));
        }
        // Reposition's "Re-show overlay" button is gone — the overlay
        // auto-pops when the roll resolves; no re-show affordance.
        // Parry's Apply Stagger button is gone — auto-staggers via
        // defendWith when the parry roll beats the linked attack.
    });
}

/** Show an interactive "move preview" overlay for the Reposition defense.
 *
 *  Highlights every grid cell the defender can reach within their per-move
 *  budget; clicking a highlighted cell snaps the token there. ESC cancels.
 *  Per RAW Witcher TRPG p.151-152 + the "Reposition" defense houserule.
 *
 *  `moveBudget` is the per-defence single-move cap in metres. The caller
 *  passes ½SPD under Combat Extended (which also enforces a per-round SPD
 *  cumulative cap) or full SPD under RAW (no round cap). This function
 *  just consumes the budget it was given.
 *
 *  Distance model: cells are eligible if (Chebyshev cell distance) × (meters
 *  per cell) ≤ moveBudget. Diagonal counts the same as orthogonal — matches
 *  the RAW "in meters" movement model and Foundry's default measureDistance
 *  for square grids without a 1.5×-diagonal house rule.
 *
 *  Idempotent: any prior overlay is torn down before showing a new one.
 */
let _repositionActive = null;
export async function showRepositionOverlay(token, moveBudget) {
    if (!canvas?.scene || !token) return;
    // Tear down any prior overlay before re-arming.
    if (_repositionActive) {
        try { _repositionActive.cleanup(); } catch (_) {}
        _repositionActive = null;
    }

    /* Combat Extended enforces a cumulative per-round SPD cap on top of
     * the per-defence budget the caller passes in. RAW (CE off) drops
     * that round cap — each individual reposition still respects
     * `moveBudget`, but you can trigger the defence as many times per
     * round as attacks come in.
     *
     * Free-Actions override wins over both: no per-defence budget and
     * no per-round cap — matches how Free Actions treats movement /
     * actions elsewhere in the codebase. The player still needs to
     * click a specific tile (this is a targeting overlay, not a warp),
     * so we grant a big-enough neighbourhood to reach anywhere on
     * screen. */
    const actor = token?.actor ?? token?.document?.actor ?? null;
    const freeActionsOn = !!actor?._freeActionsMode;
    /* Combat Extended's per-round SPD cap only applies IN combat. Out of
     * combat there are no rounds to cap against — the reposition should
     * be free to move the SPD×moveBudget distance without the CE round
     * arithmetic. Freeing the cap for out-of-combat matches how the rest
     * of the CE gates behave (also skipped when Free Actions is on). */
    const inCombat = !!actor?._inActiveCombat;
    const noRoundCap = freeActionsOn || !inCombat || !isCombatExtendedEnabled();

    if (moveBudget <= 0 && !freeActionsOn) {
        ui.notifications?.info(t("WITCHER.Doc.DefenseMixin.Notify.RepositionBudgetIs0NoDistance", "Reposition budget is 0 — no distance to spend."));
        return;
    }

    const spdCap = Number(actor?.system?.stats?.spd?.value) || 0;
    const priorMeters = Number(actor?._round?.repositionMeters) || 0;
    const roundRemaining = noRoundCap
        ? Infinity
        : (spdCap > 0 ? Math.max(0, spdCap - priorMeters) : Infinity);
    if (roundRemaining <= 0) {
        ui.notifications?.info(tFormat("WITCHER.Doc.DefenseMixin.Notify.RepositionCapReachedXmOfXm", { priorMeters: priorMeters, spdCap: spdCap }, "Reposition cap reached — {priorMeters}m of {spdCap}m used this round."));
        return;
    }
    const effectiveBudget = freeActionsOn
        ? Math.max(moveBudget, gridMetersFallback())
        : Math.min(moveBudget, roundRemaining);
    function gridMetersFallback() {
        /* Under Free Actions we want the overlay large enough to reach
         * a useful area of the canvas. 30 cells at the scene's meters-
         * per-cell gives ~30×gridMeters neighbourhood — plenty for a
         * combat encounter. */
        const gd = Number(canvas.scene.grid?.distance) || 1.5;
        return 30 * gd;
    }

    const gridSize    = Number(canvas.scene.grid?.size)     || 100;
    const gridMeters  = Number(canvas.scene.grid?.distance) || 1.5;
    const cellsRadius = Math.floor(effectiveBudget / gridMeters);
    if (cellsRadius <= 0) {
        ui.notifications?.info(tFormat("WITCHER.Doc.DefenseMixin.Notify.RepositionBudgetXmIsLessThan", { effectiveBudget: effectiveBudget, gridMeters: gridMeters }, "Reposition budget ({effectiveBudget}m) is less than one grid cell ({gridMeters}m) — no reposition distance."));
        return;
    }

    const tw      = Number(token.document?.width)  || 1;
    const th      = Number(token.document?.height) || 1;
    const baseX   = Number(token.document?.x) ?? Number(token.x);
    const baseY   = Number(token.document?.y) ?? Number(token.y);
    const baseCx  = Math.floor(baseX / gridSize);
    const baseCy  = Math.floor(baseY / gridSize);

    /* Pre-compute every reachable cell + draw EACH one as its own
     * interactive PIXI.Graphics. Per-cell event-mode = "static" makes
     * each cell its own hit-target — Foundry's higher canvas layers
     * (token, tile, grid) won't swallow the click because PIXI's
     * interaction manager hit-tests our overlay first when its z-order
     * sits on top of the canvas.controls / canvas.interface layer. */
    const overlay = new PIXI.Container();
    overlay.eventMode = "passive";   // child cells handle events themselves
    overlay.zIndex = 9999;
    overlay.sortableChildren = true;

    const commitMove = async (cx, cy) => {
        cleanup();
        try {
            /* Reposition is a defensive REACTION on someone else's turn —
             * canvas-movement.mjs's "not your turn" + budget gates would
             * otherwise block this. Set wdmFreeReposition so those gates
             * skip the check. */
            await token.document.update(
                { x: cx * gridSize, y: cy * gridSize },
                { wdmFreeReposition: true }
            );
            const movedCells = Math.max(Math.abs(cx - baseCx), Math.abs(cy - baseCy));
            const movedMeters = movedCells * gridMeters;
            /* Bank the meters against the per-round SPD cap so the next
             * reposition this round sees the shrunk budget. Harmless
             * under CE-off (roundRemaining is Infinity, the bank check
             * never trips), and keeps the meter total visible if the
             * table wants to audit reposition usage.
             *
             * Skipped under Free-Actions override — no round budget is
             * enforced against a free-acting actor, so accumulating
             * meters would just clutter the GM panel with a bogus tally.
             * Matches the "no slot spent, no state written" shape the
             * dock mixins already respect for actions and movement. */
            /* Also skip the bank when the actor isn't in an active combat —
             * `combatRound.repositionMeters` is a per-round counter, and
             * writing to it out of combat pollutes future rounds. */
            if (actor && typeof actor.update === "function" && !actor._freeActionsMode && actor._inActiveCombat) {
                try {
                    const newTotal = (Number(actor._round?.repositionMeters) || 0) + Math.round(movedMeters);
                    await actor.update({ "system.combatRound.repositionMeters": newTotal });
                } catch (err) {
                    console.warn("witcher-ttrpg-death-march | reposition meters bank failed", err);
                }
            }
            /* No confirmation toast — the token snap IS the confirmation.
             * Keeps the reposition interaction fully immersive. */
        } catch (err) {
            console.warn("witcher-ttrpg-death-march | reposition move failed", err);
            ui.notifications?.error(t("WITCHER.Doc.DefenseMixin.Notify.RepositionTokenUpdateFailedSeeConsole", "Reposition: token update failed — see console."));
        }
    };

    /* Minimalist overlay: no banner text, no per-cell meter labels — just
     * the reachable tiles. Faint amber wash on eligible squares so the
     * canvas art stays legible; hover brightens the one under the cursor.
     * Click to move, Esc to cancel. All the budget math still runs
     * upstream, but the fiction stays in the fiction. */
    const CELL_FILL_ALPHA   = 0.10;
    const CELL_BORDER_ALPHA = 0.30;
    const CELL_HOVER_ALPHA  = 0.35;
    const CELL_HOVER_BORDER = 0.90;
    const CELL_COLOUR       = 0xffe27a;   // warm saffron — reads on most terrain

    /* Single roaming distance label — one PIXI.Text reused across every
     * cell's hover events. Cheaper than one label per cell.
     *
     * Sharpness: PIXI.Text bakes the string into a texture at its own
     * `resolution` (defaults to 1). On a hi-DPI display or a zoomed
     * canvas that single-resolution texture upscales into blur. Setting
     * `resolution` to `devicePixelRatio × canvas.stage.scale` gives a
     * texture the renderer can display close to 1-to-1 pixel. Clamped
     * to 4 so a heavily zoomed-in canvas doesn't produce enormous
     * textures. */
    const dpr = window.devicePixelRatio || 1;
    const stageScale = Math.max(1, canvas?.stage?.scale?.x ?? 1);
    const textResolution = Math.min(4, dpr * stageScale);
    const hoverLabel = new PIXI.Text("", {
        fontFamily: "Signika, sans-serif",
        fontSize:   Math.max(12, Math.round(gridSize * tw * 0.2)),
        fontWeight: "300",           // thin
        fill:       0xffffff,
        stroke:     0x000000,
        strokeThickness: 2,
        align:      "center"
    });
    hoverLabel.resolution = textResolution;
    hoverLabel.anchor.set(0.5, 0.5);
    hoverLabel.alpha = 0.5;              // 50% opacity per spec
    hoverLabel.eventMode = "none";
    hoverLabel.visible = false;
    hoverLabel.zIndex = 10000;
    /* Re-bake the texture if the user zooms the canvas mid-overlay so
     * the label stays crisp at the new stage scale. Cheap since we only
     * subscribe while the overlay is alive; the listener is torn down
     * with the overlay in cleanup(). */
    const onCanvasZoom = () => {
        const s = Math.max(1, canvas?.stage?.scale?.x ?? 1);
        const res = Math.min(4, dpr * s);
        if (hoverLabel.resolution !== res) {
            hoverLabel.resolution = res;
            hoverLabel.dirty = true;     // force PIXI to re-render the texture
        }
    };
    const canvasPanHookId = Hooks.on("canvasPan", onCanvasZoom);
    overlay.addChild(hoverLabel);

    /* Wall-collision test between the token's current center and each
     * candidate cell's center. Iterates the scene's walls directly and
     * checks for any that block movement (`wall.document.move !== 0` where
     * `0 === CONST.WALL_MOVEMENT_TYPES.NONE`) and geometrically intersect
     * the line from origin to destination. Direct segment-vs-segment test
     * avoids any polygon-backend initialization quirks. */
    const originCenter = {
        x: baseX + (gridSize * tw) / 2,
        y: baseY + (gridSize * th) / 2
    };
    const wallSegments = (() => {
        const out = [];
        const placeables = canvas.walls?.placeables ?? [];
        for (const w of placeables) {
            const move = Number(w.document?.move ?? 0);
            /* WALL_MOVEMENT_TYPES.NONE === 0. Only walls that block
             * movement are considered — sight/light-only walls are fine
             * to reposition through. */
            if (move === 0) continue;
            const c = w.document?.c;
            if (!Array.isArray(c) || c.length !== 4) continue;
            out.push({ a: { x: c[0], y: c[1] }, b: { x: c[2], y: c[3] } });
        }
        return out;
    })();
    const wallBlocks = (targetCx, targetCy) => {
        const dest = {
            x: targetCx * gridSize + (gridSize * tw) / 2,
            y: targetCy * gridSize + (gridSize * th) / 2
        };
        for (const seg of wallSegments) {
            if (foundry.utils.lineSegmentIntersects(originCenter, dest, seg.a, seg.b)) return true;
        }
        return false;
    };

    for (let dy = -cellsRadius; dy <= cellsRadius; dy++) {
        for (let dx = -cellsRadius; dx <= cellsRadius; dx++) {
            if (dx === 0 && dy === 0) continue;
            const cellDist = Math.max(Math.abs(dx), Math.abs(dy));   // Chebyshev
            if (cellDist > cellsRadius) continue;
            const cx = baseCx + dx;
            const cy = baseCy + dy;
            /* Wall block — don't render a cell the token can't legally
             * reach in a straight line. */
            if (wallBlocks(cx, cy)) continue;
            const distMeters = cellDist * gridMeters;

            const cell = new PIXI.Graphics();
            cell.eventMode = "static";
            cell.cursor = "pointer";
            cell.hitArea = new PIXI.Rectangle(cx * gridSize, cy * gridSize, gridSize * tw, gridSize * th);

            const drawIdle = () => {
                cell.clear();
                cell.lineStyle(1, CELL_COLOUR, CELL_BORDER_ALPHA);
                cell.beginFill(CELL_COLOUR, CELL_FILL_ALPHA);
                cell.drawRect(cx * gridSize, cy * gridSize, gridSize * tw, gridSize * th);
                cell.endFill();
            };
            const drawHover = () => {
                cell.clear();
                cell.lineStyle(2, CELL_COLOUR, CELL_HOVER_BORDER);
                cell.beginFill(CELL_COLOUR, CELL_HOVER_ALPHA);
                cell.drawRect(cx * gridSize, cy * gridSize, gridSize * tw, gridSize * th);
                cell.endFill();
                /* Position + reveal the shared label at this cell's centre. */
                hoverLabel.text = `${distMeters}m`;
                hoverLabel.x = cx * gridSize + (gridSize * tw) / 2;
                hoverLabel.y = cy * gridSize + (gridSize * th) / 2;
                hoverLabel.visible = true;
            };
            drawIdle();

            cell.on("pointerdown", (event) => {
                event.stopPropagation();
                void commitMove(cx, cy);
            });
            cell.on("pointerover", drawHover);
            cell.on("pointerout", () => {
                drawIdle();
                hoverLabel.visible = false;
            });
            overlay.addChild(cell);
        }
    }

    /* `canvas.controls` is the top-most canvas group in v14 (above tokens,
     * grid, lighting). Attaching there means our interactive cells hit-test
     * BEFORE Foundry's standard click handlers — no stolen events. */
    const host = canvas.controls ?? canvas.interface ?? canvas.stage;
    host.addChild(overlay);

    const cleanup = () => {
        try { overlay.parent?.removeChild(overlay); overlay.destroy({ children: true }); } catch (_) {}
        try { window.removeEventListener("keydown", onKey); } catch (_) {}
        try { Hooks.off("canvasPan", canvasPanHookId); } catch (_) {}
        _repositionActive = null;
    };

    const onKey = (e) => {
        /* Silent cancel — the overlay just vanishes. Matches the
         * "no toasts" immersive treatment. */
        if (e.key === "Escape") cleanup();
    };

    window.addEventListener("keydown", onKey);
    _repositionActive = { cleanup };
}

export const defenseMixin = (Base) => class extends Base {

    /**
     * Defend with a weapon or shield. `mode` is "parry" (−3, inflicts
     * Staggered on success, no item wear) or "block" (no penalty, may spend
     * the item's Reliability). Rolls the item's skill (`skillKey`, defaulting
     * to "melee" for shields) and posts a chat card carrying the matching
     * action button. Records the defense reaction (first free, each extra
     * costs 1 STA). Returns the roll result, or null if invalid / stunned.
     */
    async defendWith(item, mode = "parry", { engagementId = "", extraMod = 0, attackerDamageFlags = null, attackHitLocation = null, attackerActor = null, attackerUuid = null } = {}) {
        if (!item || (item.type !== "weapon" && item.type !== "shield")) return null;
        if (this._stunned || cannotDefend(this)) {
            ui.notifications?.warn(tFormat("WITCHER.Doc.DefenseMixin.Notify.CantDefend", { name: this.name }, "{name} can't defend right now."));
            return null;
        }
        const skillKey = item.system?.skillKey || "melee";
        const v = this._readSkillValues(skillKey);
        if (!v) return null;

        const cm = this.system?.combatMods ?? {};
        const block   = mode === "block";
        // Parry is −3; combatMods.parryPenaltyReduction shaves it (3 = no penalty).
        // Shields get an extra, shield-only reduction (Manticore school) so a
        // shield can parry without the −3 while weapons still take it.
        const shieldRed = item.type === "shield" ? (Number(cm.shieldParryPenaltyReduction) || 0) : 0;
        // Per-weapon parry-penalty delta sourced from the wielded item's
        // qualities (Parrying = 2). Only applies on parry, not block.
        const qualityRed = block ? 0 : weaponParryPenaltyDelta(item);
        /* Blade Expertise (Wolf, Witchers Reborn) doesn't need a code
         * branch — the perk's AE writes +3 to combatMods.parryPenaltyReduction,
         * which folds through the existing `cm.parryPenaltyReduction`
         * read below and clamps the −3 penalty to 0 via the Math.min. */
        const penalty = block ? 0 : Math.min(0, -3 + (Number(cm.parryPenaltyReduction) || 0) + shieldRed + qualityRed);
        // Status penalties to defense (Staggered −2, Blinded −3, Prone −2, …),
        // summed live from the actor's active conditions.
        const statusDef = statusDefenseMod(this);
        /* CE Combat Extended — grappler / pinner physical penalty when
         * defending a third party's attack. Zero when CE is off or when
         * the defender isn't a holder. Note: no target is passed here,
         * so the "except vs partner" carve-out doesn't fire on defense
         * — an edge case (a grappler being attacked by their own
         * grapple partner is rare + the partner is at -2 themselves).
         * The attacker is now plumbed through (attackerActor/attackerUuid) so
         * the grappler's carve-out fires: no penalty defending vs the grapplee
         * they hold. Actor OR uuid string — _holdDetail resolves either. */
        const _atkActor = attackerActor ?? attackerUuid ?? null;
        const ceHoldDef = contextualPhysicalMod(this, _atkActor);
        // Ad-hoc modifier from the defense prompt — anything the defender wants
        // to fold in (cover bonus, GM ruling, situational). Adds to the total
        // and surfaces as its own chip.
        const extra = Math.round(Number(extraMod) || 0);
        // Base = governing stat + trained skill rank + skill modifier — the same
        // 1d10 + stat + skill every other roll uses — then the defense penalty
        // and any passive flat defense bonus (combatMods.flatDefenseMod).
        const base    = v.statVal + v.skillVal + v.skillMod;
        /* Combat Extended — guard contribution. Closed = +2 every defense,
         * Fool's = -2 every defense, Balanced = 0.
         *
         * Warding auto-apply: the attacker's declared hit location is
         * plumbed through requestDefenseFromOwner → runDefenseChoice →
         * here so `guardDefenseMod` can branch: +2 at the warded
         * location, −1 anywhere else. When the location IS unknown
         * (theatre-of-mind attack, no hit-location system on the strike)
         * we fall back to a note asking the GM to apply manually — the
         * old behavior. */
        const guard    = guardOf(this);
        const guardMod = guardDefenseMod(this, item, attackHitLocation);
        const wardingNote = (() => {
            if (guard.key !== "warding") return "";
            const warded = this.system?.guard?.wardingLocations?.[item.id] ?? null;
            if (!attackHitLocation) {
                return warded
                    ? `Warding this weapon at <b>${warded}</b>: +2 parry/block if the attack lands there, −1 otherwise — apply via Other Modifier (attacker's hit location wasn't threaded through).`
                    : `Warding: pick a hit location on this weapon in Guard Config to activate the +2/−1 branch.`;
            }
            if (!warded) {
                return `Warding: no location picked for <b>${item.name}</b> — pick one via Guard Config to earn the +2/−1 branch.`;
            }
            return warded === attackHitLocation
                ? `Warding <b>${warded}</b> vs attack at <b>${attackHitLocation}</b> — <b>+2</b> applied.`
                : `Warding <b>${warded}</b> vs attack at <b>${attackHitLocation}</b> — <b>−1</b> (unwarded) applied.`;
        })();
        /* ── EO weapon-quality contributions to defense ──────────────────
         * Guard / Superior Guard:        +1 / +2 to Block & Parry rolls
         * Indirect (this weapon):        -2 to Block & Parry rolls (the
         *   weapon is awkward in defense per EO p.7)
         * Feeble:                        if PARRYING with a feeble weapon,
         *   we surface a confirming note. The parry option is now GATED
         *   upstream — the defense dialog only offers a feeble parry when the
         *   attacker's weapon is itself Feeble (see defensePromptDialog +
         *   qualitiesToDamageFlags' attackerFeeble flag). So reaching this
         *   parry means it's a legal Feeble-vs-Feeble deflection; against a
         *   non-Feeble attacker the defender must Block instead (half the
         *   damage leaks through — weaponAttackMixin). */
        const guardEoBonus      = weaponGuardBonus(item);
        const indirectSelfPen   = weaponIndirectSelfPenalty(item);
        const isFeebleParry     = !block && weaponIsFeeble(item);
        const feebleNote        = isFeebleParry
            ? `Feeble (EO p.7): this weapon can only Parry other Feeble weapons — allowed here because the attacker's weapon is Feeble too. Against a non-Feeble weapon you must Block (half damage leaks through).`
            : "";
        /* EO Indirect (attacker side): when the attacker's weapon carries
         * Indirect, the DEFENDER's Block / Parry rolls take an extra -2
         * (EO p.7). This is the OTHER half of Indirect — the self-side
         * -2 is `indirectSelfPen` above. Engaged via the
         * attackerDamageFlags.indirect flag that qualitiesToDamageFlags
         * sets when the attacker's weapon has the quality. */
        const indirectVsAtk = (attackerDamageFlags?.indirect) ? -2 : 0;
        /* Pirouette is now a bonus on the attacker's next attack (see
         * weaponAttackMixin's feintBonus), not a penalty on the target's
         * defense — no defender-side branch needed. */
        const lightDef = lightDefenseMod(this);   // Darkness −2 from the defender's own tile
        const total   = base + penalty + statusDef + ceHoldDef + extra + guardMod
                      + guardEoBonus + indirectSelfPen + indirectVsAtk + lightDef
                      + (Number(cm.flatDefenseMod) || 0);
        const formula = total >= 0 ? `1d10 + ${total}` : `1d10 - ${Math.abs(total)}`;
        const title   = block ? "Block" : "Parry";

        /* Guard chip: keep this expressive so the attacker can see EXACTLY
         * why the defender's number is what it is. Warding names the
         * warded location + whether this attack landed on it; Closed /
         * Fool's just show the guard key. */
        const guardChipLabel = (() => {
            if (!guardMod) return null;
            if (guard.key !== "warding") return tFormat("WITCHER.Doc.DefenseMixin.Dialog.Button.GuardX", { guard: guard.key }, "Guard ({guard})");
            const warded = this.system?.guard?.wardingLocations?.[item.id];
            if (!warded) return `Guard (warding)`;
            if (!attackHitLocation) return `Guard (warding: ${warded})`;
            return warded === attackHitLocation
                ? `Guard (warding: ${warded} ✓)`
                : `Guard (warding: ${warded} — off)`;
        })();
        const ceHoldChip = contextualPhysicalChip(this, _atkActor);
        const defenseChips = [
            { label: statName(v.meta.statKey), value: v.statVal },
            { label: t("WITCHER.Common.Skill", "Skill"), value: v.skillVal },
            v.skillMod ? { label: t("WITCHER.Common.Mod", "Mod"), value: `${v.skillMod >= 0 ? "+" : ""}${v.skillMod}` } : null,
            penalty ? { label: title, value: String(penalty) } : null,
            statusDef ? { label: t("WITCHER.Common.Status", "Status"), value: signed(statusDef) } : null,
            ceHoldChip,
            extra ? { label: t("WITCHER.Common.Mod", "Mod"), value: signed(extra) } : null,
            guardChipLabel ? { label: guardChipLabel, value: signed(guardMod) } : null,
            guardEoBonus ? { label: t("WITCHER.Doc.DefenseMixin.Dialog.Button.WeaponGuard", "Weapon Guard"), value: signed(guardEoBonus) } : null,
            indirectSelfPen ? { label: t("WITCHER.Doc.DefenseMixin.Dialog.Button.IndirectSelf", "Indirect (self)"), value: signed(indirectSelfPen) } : null,
            indirectVsAtk ? { label: t("WITCHER.Doc.DefenseMixin.Dialog.Button.IndirectVsAtk", "Indirect (vs atk)"), value: signed(indirectVsAtk) } : null,
            lightDef ? { label: t("WITCHER.Attack.Light", "Light"), value: signed(lightDef) } : null
        ].filter(Boolean);
        const flavorBase = defenseFlavor({
            actorName: this.name,
            title,
            subtitle: `${item.name} — defense`,
            chips: defenseChips
        }) + (wardingNote ? `<div class="wdm-defense-guardnote" style="margin-top:4px;font-size:0.6875rem;opacity:0.7;">${wardingNote}</div>` : "")
          + (feebleNote  ? `<div class="wdm-defense-guardnote" style="margin-top:4px;font-size:0.6875rem;opacity:0.7;color:#b97;">${feebleNote}</div>` : "");

        // Block: keep the SP-spend button. Parry: no button — auto-stagger
        // happens below if the roll beats the attack.
        const buttons = block ? blockButtonHtml(item) : "";

        // Engagement-linked defenses suppress their own chat card — the
        // attacker's chat card folds the defense roll inline (unified UX).
        // Standalone defenses (dock buttons, no engagement) still post.
        const suppress = !!engagementId;
        const result = await extendedRoll(formula, {
            speaker: ChatMessage.getSpeaker({ actor: this }),
            flavor: flavorBase + buttons,
            flags:   (r) => engagementFlags(engagementId, r.total),
            suppressMessage: suppress
        }, { fumbleCategory: "armedDefense" });

        // NOTE: Parry's auto-stagger (RAW Core p.164: "Your opponent is
        // also staggered") fires from the ATTACKER's verdict patch, not
        // here. The attack roll happens AFTER the defense prompt resolves,
        // so at this point we don't yet know if the parry beat the attack.

        /* Pass the action key so recordDefense can read the CE base cost
         * (Parry 0, Block 0) when Combat Extended is on. Under RAW the
         * key is ignored — recordDefense falls through to its legacy
         * "1st free + 1 STA each extra" path. */
        await this.recordDefense(mode === "block" ? "block" : "parry");
        // Return the rolled total + rendered HTML chunks so callers
        // (handleDefenseRequest → back over the socket → attacker's
        // weaponAttackMixin) can compute the attack-vs-defense verdict
        // AND render the defense roll inline on the unified attack card.
        return {
            ...result, formula, mode,
            defenseTotal: Number(result?.total) || 0,
            defenseFlavor: result?.flavor ?? "",
            defenseBody:   result?.body   ?? "",
            /* Structured chip data so the ATTACKER's unified card can
             * render the defender's modifier breakdown inline (guard,
             * status, weapon-quality, etc.) — the defender's own chat
             * card is suppressed for engagement-linked defenses so
             * without this the mods are invisible to the attacker. */
            defenseChips
        };
    }

    /**
     * Defend with a skill rather than a held item — the two skill-based
     * defensive reactions:
     *
     *   DODGE       (Reflex + Dodge/Escape) — leap clear; full avoidance.
     *   RELOCATION  (DEX + Athletics)       — a specific defensive scramble
     *                out of the way. This is NOT a generic Athletics check
     *                (which also covers throwing a weapon); it's a distinct
     *                defensive action that happens to use the Athletics skill,
     *                so it posts a "Reposition — defense" card and counts
     *                against the defense economy.
     *
     * Rolls `1d10 + stat + skill` (no penalty) and records the defense
     * reaction (first free, each extra costs 1 STA). Returns the roll result,
     * or null if invalid / stunned.
     */
    async defendBySkill(skillKey, { label, engagementId = "", reposition = false, extraMod = 0, attackerDamageFlags = null, baseOverride = null, attackKind = null, attackerActor = null, attackerUuid = null } = {}) {
        /* The attacker (opponent) enables the grappler carve-out in
         * contextualPhysicalMod: a grappler takes NO penalty defending against
         * the grapplee they hold. (The grapplee's own -2 has no carve-out — it
         * always applies.) Pass the attacker as an actor OR a uuid string;
         * _holdDetail resolves either, so no fragile fromUuidSync here. */
        const _atkActor = attackerActor ?? attackerUuid ?? null;
        if (this._stunned || cannotDefend(this)) {
            ui.notifications?.warn(tFormat("WITCHER.Doc.DefenseMixin.Notify.CantDefend", { name: this.name }, "{name} can't defend right now."));
            return null;
        }
        /* baseOverride swaps the entire "stat + skill rank + mod" spine
         * — used by Witchers Reborn · Griffin · Knightly Stance to roll
         * pure Witcher Training against Disarm / Trip instead of the
         * defender's usual Dodge / Reposition skill. The extra situational
         * modifier + status + guard math still layer on top. */
        const v = baseOverride
            ? {
                  statVal:  Number(baseOverride.statVal)  || 0,
                  skillVal: Number(baseOverride.skillVal) || 0,
                  skillMod: Number(baseOverride.skillMod) || 0,
                  meta: {
                      statKey:  baseOverride.statKey  || "",
                      skillKey: baseOverride.skillKey || skillKey
                  }
              }
            : this._readSkillValues(skillKey);
        if (!v) return null;

        const title = label || game.i18n.localize(CONFIG.WITCHER.skillLabel(skillKey));
        const statusDef = statusDefenseMod(this);
        /* CE grappler/pinner penalty — see defendWith counterpart above
         * for context. Applies on Dodge / Reposition / Athletics rolls
         * routed through this generic defense path too. */
        const ceHoldDef = contextualPhysicalMod(this, _atkActor);
        const extra = Math.round(Number(extraMod) || 0);
        /* Combat Extended guard contribution. Dodge / Reposition aren't a
         * weapon defense so Warding's per-weapon location pick doesn't
         * apply (Warding modifies parry / block, not dodge / relocate per
         * rules1.png). Closed / Fool's still affect Dodge + Reposition
         * since they're flat "all defenses" effects — but NOT Resist Magic,
         * which is a WILL-based mental defense, not a physical combat stance. */
        const guard    = guardOf(this);
        const guardMod = (skillKey === "resistmagic") ? 0
                      : (guard.key === "closed") ?  2
                      : (guard.key === "fools")  ? -2
                      : 0;
        // Environmental penalties (light/sight/weather) don't apply to Resist
        // Magic — it's a WILL-based mental defense, not a perception/physical one.
        const lightDef = (skillKey === "resistmagic") ? 0 : lightDefenseMod(this);   // Darkness −2 from the defender's own tile
        // Warded (armor): +N when defending against a spell (attackKind "cast").
        const wardedDef = attackKind === "cast" ? wardedSpellDefenseBonus(this) : 0;
        const total = v.statVal + v.skillVal + v.skillMod + statusDef + ceHoldDef + extra + guardMod + lightDef + wardedDef;
        const formula = total >= 0 ? `1d10 + ${total}` : `1d10 - ${Math.abs(total)}`;

        const ceHoldChip = contextualPhysicalChip(this, _atkActor);
        const defenseChips = [
            { label: statName(v.meta.statKey), value: v.statVal },
            { label: t("WITCHER.Common.Skill", "Skill"), value: v.skillVal },
            v.skillMod ? { label: t("WITCHER.Common.Mod", "Mod"), value: `${v.skillMod >= 0 ? "+" : ""}${v.skillMod}` } : null,
            statusDef ? { label: t("WITCHER.Common.Status", "Status"), value: signed(statusDef) } : null,
            ceHoldChip,
            extra ? { label: t("WITCHER.Common.Mod", "Mod"), value: signed(extra) } : null,
            guardMod ? { label: tFormat("WITCHER.Doc.DefenseMixin.Dialog.Button.GuardX", { guard: guard.key }, "Guard ({guard})"), value: signed(guardMod) } : null,
            lightDef ? { label: t("WITCHER.Attack.Light", "Light"), value: signed(lightDef) } : null,
            wardedDef ? { label: t("WITCHER.WeaponQuality.Warded.Label", "Warded"), value: signed(wardedDef) } : null
        ].filter(Boolean);
        const flavor = defenseFlavor({
            actorName: this.name,
            title,
            subtitle: "defense",
            chips: defenseChips
        });

        const suppress = !!engagementId;
        /* Dodge / Reposition / Body Block route to the unarmed fumble
         * table (RAW folds "Unarmed Defense / Dodge / Athletics" into
         * one table). Skill-based defenses that fall outside this list
         * (rare — e.g. Deceit for feint responses) also default here. */
        const result = await extendedRoll(formula, {
            speaker: ChatMessage.getSpeaker({ actor: this }),
            flavor,
            flags:   (r) => engagementFlags(engagementId, r.total),
            suppressMessage: suppress
        }, { fumbleCategory: "unarmedDefense" });

        /* Pass the action key for CE base-cost lookup. Dodge → "dodge"
         * (1 STA base under CE); Athletics-based scramble → "reposition"
         * (2 STA base under CE — Relocate). RAW path ignores the key. */
        const defenseKey = reposition ? "reposition" : (skillKey === "dodge" ? "dodge" : null);
        await this.recordDefense(defenseKey);

        /* Reposition (Athletics-based scramble): RAW companion to the roll is
         * up to half-SPD movement. We compute the allowance, append it as a
         * note to the defense body, AUTO-show the canvas tile-picker overlay
         * (defender just clicks a highlighted square), and provide a re-arm
         * button in case the defender dismissed the overlay and wants to
         * pick again. */
        let defenseBody = result?.body ?? "";
        if (reposition) {
            const spd = Number(this.system?.stats?.spd?.value) || 0;
            /* Per-defence single-move budget is ½SPD in BOTH modes. The
             * only thing Combat Extended adds on top is a per-round
             * cumulative cap of SPD; RAW (CE off) drops that cap so the
             * player can trigger reposition as many times as attacks
             * come in, each up to ½SPD. Cap enforcement lives inside
             * showRepositionOverlay via `noRoundCap`. */
            const moveBudget = Math.max(0, Math.floor(spd / 2));
            const token = this.getActiveTokens?.()?.[0] ?? null;
            const tokenUuid = token?.document?.uuid ?? token?.uuid ?? "";
            /* No "Re-show overlay" button in the chat card — the overlay
             * auto-pops when the roll resolves, and the user explicitly
             * doesn't want a leftover button cluttering the card. If the
             * defender dismissed the overlay early, they can re-pick by
             * re-rolling Reposition (the cost of choosing). */
            defenseBody += `<div class="wdm-defense-reposition" data-move-budget="${moveBudget}" data-token-uuid="${tokenUuid}">` +
                `<span class="wdm-defense-reposition-k">${t("WITCHER.Doc.DefenseMixin.Text.Reposition", "Reposition")}</span>` +
                ` move up to <b>${moveBudget}m</b> on the canvas.` +
                (tokenUuid ? "" : ` <em>(no token on canvas — move manually)</em>`) +
            `</div>`;
            /* Auto-show the overlay so the defender doesn't have to click a
             * chat button first — straight from the defense roll into "pick
             * a tile on the canvas". Wrapped so a missing canvas / token
             * never blocks the defense card from returning. */
            if (token && moveBudget > 0) {
                try { await showRepositionOverlay(token, moveBudget); }
                catch (err) { console.warn("witcher-ttrpg-death-march | auto-reposition overlay failed", err); }
            }
        }

        return {
            ...result, formula, mode: skillKey,
            defenseTotal: Number(result?.total) || 0,
            defenseFlavor: result?.flavor ?? "",
            defenseBody,
            /* See defendWith — attacker's unified card needs the chip
             * breakdown so the defender's modifiers are visible when the
             * defender's own chat card is suppressed. */
            defenseChips
        };
    }
};
