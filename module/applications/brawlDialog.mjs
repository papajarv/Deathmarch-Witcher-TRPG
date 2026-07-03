/**
 * brawlDialog — the unarmed / brawling action dialog.
 *
 * Opened by brawlMixin.brawlAttack before the roll (the dock's Brawl button).
 * Surfaces every unarmed action from Core p.159-160 ("Fist Fighting" +
 * grappling) under one picker, plus a live to-hit total and an info box that
 * describes the selected action (rebuilt whenever the pick changes).
 *
 *   Strikes   Punch / Kick (strong/fast + called shot) · Push Kick
 *   Special   Charge · Disarm
 *   Grapple   Grapple · Pin · Choke · Throw · Trip
 *   Defense   Block (rolls Brawling as a defensive reaction)
 *
 * Brawling rolls REF + Brawling to hit and deals NON-LETHAL damage from the
 * actor's derived Punch/Kick formula. The dialog returns a structured
 * declaration the mixin turns into the roll + chat card; null on cancel.
 */

import {
    BRAWL_ACTIONS, BRAWL_GROUPS, STRIKE_TYPES, ATTACK_LOCATIONS,
    ATTACK_MODIFIERS, EXTRA_ACTION
} from "../setup/config.mjs";
import { getHoldsSync } from "../mechanics/holdRegistry.mjs";
import { normalizedActorUuid } from "../mechanics/holdLink.mjs";
import { isCombatExtendedEnabled } from "../api/homebrew.mjs";

const esc = (s) => Handlebars.escapeExpression(String(s ?? ""));
const L   = (k) => game.i18n.localize(k);
const signed = (n) => `${n >= 0 ? "+" : ""}${n}`;

/** The basic strike variants a punch/kick may use (normal/strong/fast). */
const BRAWL_STRIKES = ["normal", "strong", "fast"];

/** Resolve which UI sections an action shows. */
function actionView(meta) {
    const isStrike = meta.kind === "attack";
    return {
        isDefense:  meta.kind === "defense",
        isGrapple:  meta.kind === "grapple",
        showStrike: !!meta.strikes && !meta.forceStrike,
        /* `randomLoc: true` forces random hit location — no picker.
         * RAW-mandated for Trip (kick lands at a random spot). */
        showLocation: !!meta.location && !meta.randomLoc,
        showSituational: meta.kind !== "defense",
        forcedStrike: meta.forceStrike ?? null
    };
}

/* ── HTML builders ─────────────────────────────────────────────────────── */

function buildContent(ctx) {
    const { actionKey, aimMod, forcedExtra } = ctx;
    const meta = BRAWL_ACTIONS[actionKey] ?? BRAWL_ACTIONS.punch;
    const view = actionView(meta);

    // Action picker — grouped exactly as BRAWL_GROUPS, with a short to-hit /
    // damage tag per option so the player sees the shape before choosing.
    /* One-time reads used by the picker's gating logic below.
     *
     *   • holdsAnyGrapple — is this actor currently the HOLDER of any
     *     `grappled` pair? Drives the "grapple prereq" grey-out for
     *     Pin / Choke / Throw (RAW + CE) and Trip / Disarm / Ride
     *     (CE additions).
     *   • _ceOn — the master extendedCombat toggle. Trip / Disarm /
     *     Ride are standalone in RAW; only CE flips them to
     *     grapple-gated. */
    const actorUuid = normalizedActorUuid(ctx.actor);
    const holdsAnyGrapple = actorUuid
        ? getHoldsSync(actorUuid).some(p => p.holderUuid === actorUuid && p.kind === "grappled")
        : false;
    /* Route through the canonical `isCombatExtendedEnabled()` helper so
     * this stays in step with everywhere else that reads the CE toggle
     * (brawlMixin, holdModifiers, statusOverrides). Direct
     * `game.settings.get(...) === true` had a subtle failure mode: the
     * setting object's stored value can come back as truthy-but-not-
     * strict-true depending on how a GM edited it (e.g. a JSON import
     * that landed `1`), which the strict compare silently dropped. */
    let _ceOn = false;
    try { _ceOn = !!isCombatExtendedEnabled(); }
    catch (_) { /* settings not ready — default to RAW-only gating */ }
    /* CE grapple-gated actions. Per the user-supplied CE spec:
     *   Ride  — "You can attempt to climb onto a larger enemy if you're
     *           grappling them OR on higher ground." Grapple is one of
     *           two prereqs (the runtime prompt covers the higher-ground
     *           alternative when the actor isn't currently grappling).
     *
     * Trip and Disarm are NOT in this set — per the CE spec they're
     * STANDALONE actions with enhancements when grappling (Trip gets
     * double kick + 1d6m tumble + Stun save; Disarm gets a DC 18 steal +
     * random toss rider). The runtime `ceTripEnhanced` / disarm rider
     * hooks handle the enhancement; gating them on grapple would break
     * their standalone use. */
    const CE_GRAPPLE_GATED = new Set(["ride"]);
    /* Actions that only exist as valid picks when Combat Extended is on.
     * Trip / Disarm stay visible under RAW (Core p.163 lists both as
     * standalone options); the CE-only additions are the ones RAW has
     * no analogue for. Filtered out of the picker entirely rather than
     * shown greyed — under RAW they're conceptually not offered at all,
     * so a "you can't do that" grey-out would misrepresent the ruleset. */
    const CE_ONLY_ACTIONS = new Set(["ride", "reverseGrapple", "push"]);
    /* Grapple / Release Grapple contextual visibility. A grappler is
     * conceptually COMMITTED to their current hold — they don't stand
     * around looking for a new opponent to grab while still holding the
     * first one. So when the actor is already the holder of any
     * grappled pair:
     *   • the `grapple` (initiate) action is HIDDEN — you're already in
     *     a grapple, offering a fresh Grapple button here misleads.
     *   • the `releaseGrapple` action becomes VISIBLE — the voluntary
     *     end of the hold, which we only offer while there's a hold to
     *     let go of. Inverse gate: hidden when there's nothing held.
     * Filtered out (not just greyed) — an unavailable-by-context action
     * shouldn't take up a picker slot. */
    const isHolder = holdsAnyGrapple;

    const optionFor = (key) => {
        const a = BRAWL_ACTIONS[key];
        const bits = [];
        if (a.kind === "defense") bits.push("defend");
        if (a.damage)  bits.push(a.half ? `½ ${a.damage}` : a.damage);
        if (a.kind === "grapple" && !a.damage) bits.push("no dmg");
        if (a.fullRound) bits.push("full round");
        // Action economy: attacks/grapples need an action slot; Block is a
        // defensive reaction and stays available. Charge additionally needs the
        // whole turn free.
        const needsSlot = a.kind !== "defense";
        /* Escape (RAW Core "Brawling & Wrestling") requires the actor to
         * currently be in a hold pair. Gate the option so it's greyed
         * out when there's nothing to escape from. The status set on the
         * escaping actor mirrors HOLD_STATUSES in mechanics/holdLink. */
        const heldStatuses = ["grappled", "pinned", "clinched", "chokeheld"];
        const isHeld = heldStatuses.some(s => ctx.actor?.statuses?.has?.(s));
        const escapeBlocked = a.requiresHeld && !isHeld;
        /* Reverse Grapple (CE Combat Extended 2026-07-03) requires the
         * actor to be grappled but NOT also pinned or choked. Grey out
         * when either condition fails so the picker mirrors Escape's
         * "not held" affordance. Same self-state check — no target
         * lookup needed because reversal is on the actor's own hold. */
        const isGrappled     = ctx.actor?.statuses?.has?.("grappled") === true;
        const isPinnedOrChoked = ["pinned", "chokeheld"].some(s => ctx.actor?.statuses?.has?.(s));
        const reverseBlocked = a.requiresGrappledOnly && (!isGrappled || isPinnedOrChoked);
        /* Grapple-prereq gate (CE + RAW). Pin / Choke / Throw carry
         * `needsGrapple: true` in BRAWL_ACTIONS; Trip / Disarm / Ride
         * flip to grapple-gated under CE via CE_GRAPPLE_GATED. Grey out
         * when the actor isn't currently the holder of any `grappled`
         * pair — the picker doesn't know the target yet, so this is
         * the loose gate (holds ANYONE); the runtime check in
         * brawlMixin tightens to "holds THIS target" and warns if not. */
        const wantsGrapple = a.needsGrapple === true || (_ceOn && CE_GRAPPLE_GATED.has(key));
        const grappleBlocked = wantsGrapple && !holdsAnyGrapple;
        const blocked = (needsSlot && !ctx.canAct) || (a.fullRound && !ctx.canFullRound) || escapeBlocked || reverseBlocked || grappleBlocked;
        if (needsSlot && !ctx.canAct) bits.push(L("WITCHER.Attack.NeedsAction"));
        else if (a.fullRound && !ctx.canFullRound) bits.push(L("WITCHER.Attack.NeedsFullRound"));
        else if (escapeBlocked) bits.push("not held");
        else if (reverseBlocked) bits.push(isPinnedOrChoked ? "pin/choke first" : "not grappled");
        else if (grappleBlocked) bits.push("no grapple");
        const tail = bits.length ? ` (${bits.join(", ")})` : "";
        const sel  = (key === actionKey && !blocked) ? " selected" : "";
        /* `data-blocked="1"` is a secondary JS hook: some Chromium/Electron
         * builds ignore CSS colors on <option> and render disabled options
         * indistinguishably from enabled ones. The render() handler reads
         * this attribute on change to snap the picker back to the previous
         * valid action, so the "non-selectable" contract holds even when the
         * visual `disabled` fade doesn't paint. Prefixing the label with "⊘"
         * gives a text-level cue that never depends on the theme. */
        const prefix = blocked ? "⊘ " : "";
        return `<option value="${key}"${sel}${blocked ? ' disabled data-blocked="1"' : ""}>${esc(prefix + L(a.labelKey))}${esc(tail)}</option>`;
    };
    /* Charging status (from dock's Full Round → Charge) locks the
     * brawl picker to the Charge action only — user's spec: "only
     * let me select strong strike". BRAWL_ACTIONS.charge forces
     * strong strike internally; the fullRound + prone-on-block
     * rider fire the same way as if picked from a normal menu. */
    const _isCharging = !!ctx.actor?.statuses?.has?.("charging");
    /* Filter picker entries by static + contextual visibility. Empty
     * groups (all their entries filtered out) are also dropped so we
     * don't render a labeled optgroup with zero children. */
    const visibleActionsFor = (group) =>
        group.actions.filter(k => {
            /* CE-only actions vanish under RAW. */
            if (!_ceOn && CE_ONLY_ACTIONS.has(k)) return false;
            /* `grapple` (initiate) hides when the actor is already holding
             * someone — a fresh Grapple button while committed to a hold
             * misleads. `releaseGrapple` mirrors: only visible while there
             * IS a hold to voluntarily let go of. */
            if (k === "grapple" && isHolder) return false;
            if (k === "releaseGrapple" && !isHolder) return false;
            return true;
        });
    const actionOpts = _isCharging
        ? `<optgroup label="${esc(L("WITCHER.Brawl.GroupSpecial"))}">${optionFor("charge")}</optgroup>`
        : BRAWL_GROUPS.map(g => {
            const keys = visibleActionsFor(g);
            if (!keys.length) return "";
            return `<optgroup label="${esc(L(g.labelKey))}">${keys.map(optionFor).join("")}</optgroup>`;
        }).join("");

    // Strike-type picker (punch/kick only). Charge forces a strong strike and
    // shows it read-only instead.
    const strikeOption = (key) => {
        const s = STRIKE_TYPES[key];
        const bits = [];
        if (s.toHit) bits.push(signed(s.toHit));
        if (s.dmgMult !== 1) bits.push(`×${s.dmgMult} dmg`);
        if (s.attacks > 1) bits.push(`${s.attacks} attacks`);
        const tail = bits.length ? ` (${bits.join(", ")})` : "";
        return `<option value="${key}"${key === "normal" ? " selected" : ""}>${esc(L(s.labelKey))}${esc(tail)}</option>`;
    };
    const strikeField = view.showStrike ? `
        <div class="wdm-atk-field">
            <label>${esc(L("WITCHER.Attack.Strike"))}</label>
            <select name="strike">${BRAWL_STRIKES.map(strikeOption).join("")}</select>
        </div>` : "";
    const forcedStrikeField = view.forcedStrike ? `
        <div class="wdm-atk-field">
            <label>${esc(L("WITCHER.Attack.Strike"))}</label>
            <div class="wdm-atk-readonly">${esc(L(STRIKE_TYPES[view.forcedStrike].labelKey))}</div>
        </div>` : "";

    // Hit-location picker (punch/kick). Push Kick forces the torso.
    const locOpts = [
        `<option value="random:human">${esc(L("WITCHER.Attack.LocRandomHuman"))}</option>`,
        `<option value="random:monster">${esc(L("WITCHER.Attack.LocRandomMonster"))}</option>`,
        ...Object.entries(ATTACK_LOCATIONS).map(([key, loc]) => {
            const pen = loc.penalty + aimMod;
            const penTxt = pen ? ` (${signed(pen)})` : "";
            const multTxt = loc.mult !== 1 ? ` ×${loc.mult}` : "";
            return `<option value="loc:${key}">${esc(L(loc.labelKey))}${esc(penTxt)}${esc(multTxt)}</option>`;
        })
    ].join("");
    const locField = view.showLocation ? `
        <div class="wdm-atk-field wdm-atk-field-wide" data-loc-field>
            <label>${esc(L("WITCHER.Attack.Location"))}</label>
            <select name="location">${locOpts}</select>
        </div>` : "";

    // Situational toggles (melee subset — drop the ranged-only ones).
    const sitRows = ATTACK_MODIFIERS
        .filter(m => !m.rangedOnly)
        .map(m => `<label class="wdm-atk-check">
            <input type="checkbox" name="sit" value="${m.value}" data-mod="${m.mod}" />
            <span>${esc(L(m.labelKey))} <em>${signed(m.mod)}</em></span>
        </label>`).join("");
    const sitBlock = view.showSituational ? `
        <div class="wdm-atk-sit-block" data-sit-block>
            <div class="wdm-atk-section-label">${esc(L("WITCHER.Attack.Situational"))}</div>
            <div class="wdm-atk-checks">${sitRows}</div>
        </div>` : "";

    const otherModField = !view.isDefense ? `
        <div class="wdm-atk-field">
            <label>${esc(L("WITCHER.Attack.OtherMod"))}</label>
            <input type="number" name="otherMod" step="1" value="0" />
        </div>` : "";

    const extraActionBlock = (forcedExtra && !view.isDefense) ? `
        <div class="wdm-atk-weather wdm-atk-extra">
            <span class="wdm-atk-weather-k"><i class="fa-solid fa-bolt-lightning"></i> ${esc(L("WITCHER.Attack.ExtraActionForced"))}</span>
            <span class="wdm-atk-weather-v">${signed(EXTRA_ACTION.toHit)}, ${EXTRA_ACTION.staCost} STA</span>
        </div>` : "";

    // The selected action's own rider note (what it does / what happens on a
    // hit). Rebuilt with the card on every action change, so it always describes
    // the current pick — this is the in-dialog explanation of each action.
    const noteBlock = meta.note ? `
        <div class="wdm-atk-note" data-action-note>
            <i class="fa-solid fa-circle-info"></i> ${esc(L(meta.note))}
        </div>` : "";

    // The total readout only matters for rolls that have a to-hit (every
    // action does — block included, as a defensive Brawling roll).
    const totalBlock = `
        <div class="wdm-atk-total">
            <span class="wdm-atk-total-k">${esc(L(view.isDefense ? "WITCHER.Brawl.DefenseTotal" : "WITCHER.Attack.TotalToHit"))}</span>
            <span class="wdm-atk-total-v" data-total>1d10</span>
        </div>
        <div class="wdm-atk-breakdown" data-breakdown></div>`;

    return `
    <div class="wdm-atk wdm-brawl" data-action="${esc(actionKey)}">
        <div class="wdm-atk-grid">
            <div class="wdm-atk-field wdm-atk-field-wide">
                <label>${esc(L("WITCHER.Brawl.Action"))}</label>
                <select name="action">${actionOpts}</select>
            </div>
            ${strikeField}
            ${forcedStrikeField}
            ${locField}
            ${otherModField}
        </div>
        ${noteBlock}
        ${extraActionBlock}
        ${sitBlock}
        ${totalBlock}
    </div>`;
}

/* ── Read + compute ────────────────────────────────────────────────────── */

function collect(root, ctx) {
    const { aimMod, forcedExtra } = ctx;
    const q = (sel) => root.querySelector(sel);

    const actionKey = q('[name="action"]')?.value || ctx.actionKey || "punch";
    const meta = BRAWL_ACTIONS[actionKey] ?? BRAWL_ACTIONS.punch;
    const view = actionView(meta);

    // Strike type: the picker for punch/kick, the forced strike for charge,
    // else a plain normal strike.
    const strikeKey = view.forcedStrike
        ? view.forcedStrike
        : (view.showStrike ? (q('[name="strike"]')?.value || "normal") : "normal");
    const strike = STRIKE_TYPES[strikeKey] ?? STRIKE_TYPES.normal;

    // Location (punch/kick) or the action's fixed location (push kick → torso).
    let location = { mode: "none", penalty: 0, mult: 1, label: "" };
    if (meta.fixedLoc) {
        const loc = ATTACK_LOCATIONS[meta.fixedLoc];
        location = { mode: "specific", key: meta.fixedLoc, penalty: 0, mult: loc?.mult ?? 1, label: L(loc?.labelKey ?? meta.fixedLoc) };
    } else if (meta.randomLoc) {
        /* Trip (RAW): kick damage to a RANDOM hit location — no picker.
         * brawlMixin rolls the d10 face after the dialog closes. */
        location = { mode: "random", kind: "human", penalty: 0, mult: null, label: L("WITCHER.Attack.LocRandomHuman") };
    } else if (view.showLocation) {
        const locVal = q('[name="location"]')?.value || "random:human";
        if (locVal.startsWith("random:")) {
            location = { mode: "random", kind: locVal.split(":")[1] || "human", penalty: 0, mult: null, label: L(locVal.endsWith("monster") ? "WITCHER.Attack.LocRandomMonster" : "WITCHER.Attack.LocRandomHuman") };
        } else {
            const key = locVal.split(":")[1];
            const loc = ATTACK_LOCATIONS[key];
            location = { mode: "specific", key, penalty: (loc?.penalty ?? 0) + aimMod, mult: loc?.mult ?? 1, label: L(loc?.labelKey ?? key) };
        }
    }

    const situational = view.showSituational
        ? [...root.querySelectorAll('[name="sit"]:checked')].map(el => {
            const def = ATTACK_MODIFIERS.find(m => m.value === el.value);
            return { value: el.value, mod: Number(el.dataset.mod) || 0, label: L(def?.labelKey ?? el.value) };
          })
        : [];

    const otherMod = view.isDefense ? 0 : Math.round(Number(q('[name="otherMod"]')?.value) || 0);
    const extraAction = !!forcedExtra && !view.isDefense;

    // Assemble the modifier breakdown + total. Block is a Brawling defense roll
    // with no attack modifiers, so only its base applies.
    const chips = [];
    let modTotal = 0;
    const add = (label, value) => { if (value) { modTotal += value; chips.push({ label, value }); } };

    if (!view.isDefense) {
        if (strike.toHit) add(L(strike.labelKey), strike.toHit);
        if (extraAction)  add(L("WITCHER.Attack.ExtraAction"), EXTRA_ACTION.toHit);
        if (location.mode === "specific" && location.penalty) add(location.label, location.penalty);
        for (const s of situational) add(s.label, s.mod);
        if (otherMod) add(L("WITCHER.Attack.OtherMod"), otherMod);
    }

    return {
        action: actionKey, actionMeta: meta,
        strike: strikeKey, strikeMeta: strike,
        location, situational, otherMod, extraAction,
        chips, modTotal,
        grandMod: (ctx.base?.total ?? 0) + modTotal
    };
}

function refresh(root, ctx) {
    const r = collect(root, ctx);
    const totalEl = root.querySelector("[data-total]");
    if (totalEl) totalEl.textContent = r.grandMod ? `1d10 ${signed(r.grandMod)}` : "1d10";

    const bdEl = root.querySelector("[data-breakdown]");
    if (bdEl) {
        const baseChips = (ctx.base?.chips ?? []).map(c =>
            `<span class="wdm-atk-chip is-base"><span class="k">${esc(c.label)}</span><span class="v">${esc(c.value)}</span></span>`);
        const modChips = r.chips.map(c =>
            `<span class="wdm-atk-chip ${c.value < 0 ? "is-neg" : "is-pos"}"><span class="k">${esc(c.label)}</span><span class="v">${signed(c.value)}</span></span>`);
        bdEl.innerHTML = [...baseChips, ...modChips].join("");
    }
}

/* ── Public entry ──────────────────────────────────────────────────────── */

/**
 * Open the brawl dialog.
 * @param {Actor}  actor  the attacker
 * @param {object} opts   { base:{ total, chips } } — the Brawling skill portion,
 *                        shown read-only in the breakdown
 * @returns {Promise<object|null>}  the collect() result, or null on cancel
 */
export async function openBrawlDialog(actor, opts = {}) {
    const aimMod = Number(actor?.system?.derivedStats?.aimMod) || 0;
    const forcedExtra = actor?.nextActionSlot === "extra";

    // Action economy: with no action slot left, attacks/grapples are disabled and
    // only Block (a defensive reaction) remains — so default the picker to it.
    const canAct = actor?.hasActionSlot !== false;
    /* Charging (from dock's Full Round → Charge) forces the picker to
     * Charge only — default the initial actionKey so the dialog opens
     * pre-selected on it. */
    const isCharging = !!actor?.statuses?.has?.("charging");
    const initialAction = isCharging ? "charge" : (canAct ? "punch" : "block");
    const ctx = {
        actor, actionKey: initialAction,
        base: opts.base ?? { total: 0, chips: [] },
        aimMod, forcedExtra, canAct,
        // Gates the full-round Charge action in the picker.
        canFullRound: actor?.canTakeFullRound !== false
    };

    const result = await foundry.applications.api.DialogV2.wait({
        window: { title: L("WITCHER.Brawl.DialogTitle"), icon: "fa-solid fa-hand-fist" },
        content: buildContent(ctx),
        classes: ["wdm-atk-dialog", "wdm-brawl-dialog"],
        buttons: [
            { action: "roll", label: L("WITCHER.Brawl.RollButton"), icon: "fa-solid fa-hand-fist", default: true,
              callback: (_event, _button, dialog) => collect(dialog.element, ctx) },
            { action: "cancel", label: L("WITCHER.Cancel"), icon: "fa-solid fa-xmark" }
        ],
        rejectClose: false,
        render: (_event, dialog) => {
            const root = dialog.element;
            refresh(root, ctx);
            root.addEventListener("change", (e) => {
                // Changing the action swaps which fields apply (strike/location
                // appear for punch/kick, vanish for grapple/block), so rebuild.
                if (e.target?.name === "action") {
                    /* Belt-and-suspenders for the disabled-option contract:
                     * if the newly-selected option carries data-blocked, snap
                     * the picker back to the previous valid action and skip
                     * the rebuild. Handles the Electron/Chromium edge where
                     * `disabled` on <option> is honored by the OS dropdown
                     * paint but somehow still commits a value change. */
                    const opt = e.target.selectedOptions?.[0];
                    if (opt?.dataset?.blocked === "1") {
                        e.target.value = ctx.actionKey;
                        return;
                    }
                    ctx.actionKey = e.target.value;
                    const host = root.querySelector(".wdm-atk");
                    if (host) host.outerHTML = buildContent(ctx);
                }
                refresh(root, ctx);
            });
            root.addEventListener("input", () => refresh(root, ctx));
        }
    }).catch(() => null);

    return (result && typeof result === "object") ? result : null;
}
