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
        showLocation: !!meta.location,
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
        const blocked = (needsSlot && !ctx.canAct) || (a.fullRound && !ctx.canFullRound);
        if (needsSlot && !ctx.canAct) bits.push(L("WITCHER.Attack.NeedsAction"));
        else if (a.fullRound && !ctx.canFullRound) bits.push(L("WITCHER.Attack.NeedsFullRound"));
        const tail = bits.length ? ` (${bits.join(", ")})` : "";
        const sel  = (key === actionKey && !blocked) ? " selected" : "";
        return `<option value="${key}"${sel}${blocked ? " disabled" : ""}>${esc(L(a.labelKey))}${esc(tail)}</option>`;
    };
    const actionOpts = BRAWL_GROUPS.map(g =>
        `<optgroup label="${esc(L(g.labelKey))}">${g.actions.map(optionFor).join("")}</optgroup>`
    ).join("");

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
    const ctx = {
        actor, actionKey: canAct ? "punch" : "block",
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
