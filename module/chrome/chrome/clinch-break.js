/**
 * clinch-break.js — the HOLDS indicator: a stack of pills floating just above
 * the dock, one per hold the viewed/controlled actor is in. Each pill is
 * role-aware:
 *
 *   • HOLDER (you're holding someone) → a "Break …" action pill. Clicking
 *     RELEASES every hold of that kind you're maintaining. Free for grapple /
 *     pin / choke (no action). Clinch additionally costs 1 movement and the
 *     clear path re-centres you off the grid line.
 *   • TARGET (someone holds you) → a read-only indicator. You break a clinch
 *     by MOVING away; a grapple / pin / choke by the ESCAPE action.
 *
 * Pills stack upward above the dock (newest on top), so multiple simultaneous
 * holds are all visible.
 */

import { getAssignedActor, VIEWER_OVERRIDE_HOOK } from "../lib/actor.js";
import { getHoldLinks, clearHoldLink } from "../../mechanics/holdLink.mjs";
import { t } from "../lib/i18n.js";

const CONTAINER_ID = "wou-holds";

/* Per-kind UI config. `holderFree` = releasing costs no action/movement.
 * Order here is the render order (rendered into a column-reverse container, so
 * later entries sit lower / nearer the dock). */
const HOLD_KINDS = [
    { kind: "chokeheld", holderLabel: "WITCHER.Chrome.Holds.BreakChoke",   holderFallback: "Break Choke",   targetLabel: "WITCHER.Chrome.Holds.Chokehold", targetFallback: "Chokehold", icon: "fa-hand-fist",     holderFree: true,  escapeTarget: true },
    { kind: "pinned",    holderLabel: "WITCHER.Chrome.Holds.BreakPin",     holderFallback: "Break Pin",     targetLabel: "WITCHER.Chrome.Holds.Pinned",    targetFallback: "Pinned",    icon: "fa-down-long",     holderFree: true,  escapeTarget: true },
    { kind: "grappled",  holderLabel: "WITCHER.Chrome.Holds.BreakGrapple", holderFallback: "Break Grapple", targetLabel: "WITCHER.Chrome.Holds.Grappled",  targetFallback: "Grappled",  icon: "fa-hands-holding", holderFree: true,  escapeTarget: true },
    { kind: "clinched",  holderLabel: "WITCHER.Chrome.Clinch.Break",       holderFallback: "Break Clinch",  targetLabel: "WITCHER.Chrome.Clinch.Clinched", targetFallback: "Clinched",  icon: "fa-hand-back-fist", holderFree: false, escapeTarget: false }
];
const KIND_BY = Object.fromEntries(HOLD_KINDS.map(k => [k.kind, k]));

/** Candidate actors whose holds the indicator reflects: assigned/viewed
 *  actor, the user's character, and any controlled token's actor (a GM with
 *  no character selects the token). De-duped, priority order. */
function candidateActors() {
    const out = [];
    const add = (a) => { if (a && !out.includes(a)) out.push(a); };
    add(getAssignedActor());
    add(game?.user?.character);
    for (const tk of (canvas?.tokens?.controlled ?? [])) add(tk?.actor);
    return out;
}

/** The first candidate that is in ANY hold, plus its pairs. Player-safe:
 *  getHoldLinks awaits + warms the registry cache. Returns {actor, pairs}. */
async function heldCandidate() {
    for (const a of candidateActors()) {
        let pairs = [];
        try { pairs = await getHoldLinks(a); } catch (_) { pairs = []; }
        pairs = pairs.filter(p => KIND_BY[p.kind]);
        // Status fallback so the held side still shows even on a cold cache.
        const statusKinds = HOLD_KINDS
            .filter(k => { try { return !!a.statuses?.has?.(k.kind); } catch (_) { return false; } })
            .map(k => ({ kind: k.kind, role: "target", partnerUuid: null }));
        for (const s of statusKinds) {
            /* Only trust the status fallback when the registry knows NOTHING of
             * that kind for this actor — never add a "target" pill for a kind
             * they're already the HOLDER of (you can't be grappler and grapplee
             * of the same grapple; a stale status shouldn't fake it). */
            if (!pairs.some(p => p.kind === s.kind)) pairs.push(s);
        }
        if (pairs.length) return { actor: a, pairs };
    }
    return null;
}

/** Inject the (empty, hidden) holds container once and wire refresh hooks. */
export function injectClinchBreakButton() {
    if (document.getElementById(CONTAINER_ID)) return;
    /* Mount on <body>, NOT #interface — the chrome scales #ui-middle with
     * transform:scale, and a transformed ancestor turns position:fixed into
     * "fixed relative to the transform". body is the untransformed root. */
    document.body.insertAdjacentHTML("beforeend", `<div id="${CONTAINER_ID}" hidden></div>`);
    const box = document.getElementById(CONTAINER_ID);
    box?.addEventListener("click", onPillClick);

    Hooks.on("canvasReady", scheduleRefresh);
    Hooks.on("controlToken", scheduleRefresh);
    Hooks.on("updateActor", scheduleRefresh);
    Hooks.on("updateToken", scheduleRefresh);
    /* Hold STATUSES are ActiveEffects in v13 — stripping `grappled` on escape
     * fires create/deleteActiveEffect (NOT updateActor), so listen to those
     * too or a hold pill lingers after the hold ends. */
    Hooks.on("createActiveEffect", scheduleRefresh);
    Hooks.on("deleteActiveEffect", scheduleRefresh);
    Hooks.on(VIEWER_OVERRIDE_HOOK, scheduleRefresh);
    scheduleRefresh();
}

let _pending = false;
function scheduleRefresh() {
    if (_pending) return;
    _pending = true;
    requestAnimationFrame(() => { _pending = false; refreshClinchBreak(); });
}

/** Rebuild the holds stack for the current viewed/controlled actor. */
export async function refreshClinchBreak() {
    const box = document.getElementById(CONTAINER_ID);
    if (!box) return;
    const st = await heldCandidate();
    const cur = document.getElementById(CONTAINER_ID);
    if (!cur) return;
    if (!st) { cur.hidden = true; cur.innerHTML = ""; return; }

    /* Grapplee lock: if this actor is the TARGET of a grapple-family hold
     * (grappled / pinned / chokeheld) they are the NON-dominant party — held.
     * Breaking a clinch collapses the whole stack (clinch is the base), so a
     * held actor who also happens to HOLD a clinch (mutual / reverse clinch)
     * could otherwise shortcut out of the grapple by dropping that clinch,
     * skipping the opposed Escape roll. Disable the Break-Clinch pill for them
     * — they must use the Escape action. */
    const isGrapplee = st.pairs.some(p =>
        p.role === "target" && (p.kind === "grappled" || p.kind === "pinned" || p.kind === "chokeheld"));

    /* One pill per (kind, role) the actor is in, in HOLD_KINDS order. */
    const pills = [];
    for (const cfg of HOLD_KINDS) {
        const isHolder = st.pairs.some(p => p.kind === cfg.kind && p.role === "holder");
        const isTarget = st.pairs.some(p => p.kind === cfg.kind && p.role === "target");
        if (isHolder) {
            const clinchLocked = cfg.kind === "clinched" && isGrapplee;
            const ttl = clinchLocked
                ? t("WITCHER.Chrome.Clinch.LockedGrappled", "You're being held — use the Escape action to break free. You can't drop the clinch while grappled.")
                : t(cfg.holderLabel, cfg.holderFallback);
            const breakBtn = `<button type="button" class="wou-hold-pill${clinchLocked ? " is-disabled" : ""}" data-kind="${cfg.kind}" data-role="holder" data-disabled="${clinchLocked ? "1" : ""}"
                          title="${escAttr(ttl)}">
                          <i class="fa-solid ${cfg.icon}"></i><span>${escText(t(cfg.holderLabel, cfg.holderFallback))}</span>
                        </button>`;
            if (cfg.kind === "chokeheld") {
                /* Choke gets a MAINTAIN pill to the RIGHT of Break Choke — a manual
                 * fallback to the turn-start upkeep prompt: spend an action + deal
                 * this turn's suffocation WITHOUT breaking the hold. Greyed once
                 * the choke has already been maintained/applied THIS round
                 * (chokeRound === the current combat round). */
                const curRound   = Number(game?.combat?.round) || 0;
                const chokeRound  = Number(st.actor?.getFlag?.("witcher-ttrpg-death-march", "chokeRound"));
                const maintained  = curRound > 0 && Number.isFinite(chokeRound) && chokeRound === curRound;
                const mTtl = maintained
                    ? t("WITCHER.Chrome.Holds.ChokeMaintainedThisTurn", "Choke already maintained this turn.")
                    : t("WITCHER.Chrome.Holds.MaintainChoke", "Maintain choke — deal suffocation (1 action)");
                const maintainBtn = `<button type="button" class="wou-hold-pill${maintained ? " is-disabled" : ""}" data-kind="chokeheld" data-role="maintain" data-disabled="${maintained ? "1" : ""}"
                              title="${escAttr(mTtl)}">
                              <i class="fa-solid fa-lungs"></i><span>${escText(t("WITCHER.Chrome.Holds.MaintainChokeShort", "Maintain"))}</span>
                            </button>`;
                /* Row so Break (left) + Maintain (right) sit side by side; the
                 * container is inert, the buttons re-enable pointer events. */
                pills.push(`<div class="wou-hold-row" style="display:flex;gap:0.25rem;align-items:center;pointer-events:none;">${breakBtn}${maintainBtn}</div>`);
            } else {
                pills.push(breakBtn);
            }
        }
        if (isTarget) {
            pills.push(`<button type="button" class="wou-hold-pill is-indicator" data-kind="${cfg.kind}" data-role="target"
                          title="${escAttr(t(cfg.targetLabel, cfg.targetFallback))}">
                          <i class="fa-solid ${cfg.icon}"></i><span>${escText(t(cfg.targetLabel, cfg.targetFallback))}</span>
                        </button>`);
        }
    }
    if (!pills.length) { cur.hidden = true; cur.innerHTML = ""; return; }
    cur.innerHTML = pills.join("");
    cur.hidden = false;
}

async function onPillClick(ev) {
    const pill = ev.target?.closest?.(".wou-hold-pill");
    if (!pill) return;
    ev.preventDefault();
    ev.stopPropagation();
    const kind = pill.dataset.kind;
    const role = pill.dataset.role;
    const cfg  = KIND_BY[kind];
    if (!cfg) return;
    const st = await heldCandidate();
    if (!st) { scheduleRefresh(); return; }
    const actor = st.actor;

    /* Grapplee lock (see refreshClinchBreak): a held actor can't drop the
     * clinch to shortcut out of the grapple — surface why, don't act. */
    if (pill.dataset.disabled === "1") {
        ui.notifications?.info(pill.title || t("WITCHER.Chrome.Clinch.LockedGrappled", "You're being held — use the Escape action to break free."));
        scheduleRefresh();
        return;
    }

    /* Maintain Choke — manual fallback to the turn-start upkeep prompt: spend an
     * action and deal this turn's suffocation to every foe you choke, keeping
     * the hold. */
    if (role === "maintain") {
        const { maintainChokeOnce, chokeTargetsOf, findStranglingWeapon } = await import("../../mechanics/choke.mjs");
        const targets = await chokeTargetsOf(actor);
        if (!targets.length) { scheduleRefresh(); return; }
        const weapon = findStranglingWeapon(actor);
        for (const tgt of targets) await maintainChokeOnce(actor, tgt, weapon);
        scheduleRefresh();
        return;
    }

    /* TARGET pills are read-only reminders of how to break free. */
    if (role === "target") {
        ui.notifications?.info(cfg.escapeTarget
            ? t("WITCHER.Chrome.Holds.EscapeToBreak", "Use the Escape action (Dodge/Escape vs the holder's Brawling) to break free.")
            : t("WITCHER.Chrome.Clinch.MoveToBreak", "You're clinched — move away to break it."));
        scheduleRefresh();
        return;
    }

    /* HOLDER pill: release the hold(s) of this kind you maintain. The holds
     * form a dependency STACK — clinch (base) → grapple → pin/choke (top) —
     * so breaking a layer collapses everything built ON it, but leaves the
     * layers BELOW it standing:
     *   - clinch  → drops the whole stack (grapple + pin/choke go with it).
     *   - grapple → drops grapple + pin/choke, but the clinch survives.
     *   - pin / choke (top) → peel just that layer; grapple + clinch stay.
     * Free for grapple/pin/choke; clinch costs 1 movement (its clear path
     * re-centres off the grid). */
    const DROP_BY_KIND = {
        clinched:  ["chokeheld", "pinned", "grappled", "clinched"],
        grappled:  ["chokeheld", "pinned", "grappled"],
        pinned:    ["pinned"],
        chokeheld: ["chokeheld"]
    };
    const dropKinds = DROP_BY_KIND[kind] ?? [kind];
    const partners = (await getHoldLinks(actor))
        .filter(p => p.kind === kind && p.role === "holder")
        .map(p => p.partnerUuid);
    for (const partnerUuid of partners) {
        try {
            const partner = partnerUuid ? await fromUuid(partnerUuid) : null;
            for (const k of dropKinds) {
                await clearHoldLink(actor, "break-button", partner ?? null, k);
            }
        } catch (err) {
            console.warn(`witcher-ttrpg-death-march | ${kind} release failed`, err);
        }
    }
    if (!cfg.holderFree && actor._inActiveCombat) {
        const oneTile = Number(canvas?.scene?.grid?.distance) || 1;
        try { await actor.recordMovement?.(oneTile); } catch (_) { /* best-effort */ }
    }
    scheduleRefresh();
}

/* Tiny local escapers (avoid importing the chrome escape helpers for two uses). */
function escText(s) { return String(s ?? "").replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }
function escAttr(s) { return escText(s).replace(/"/g, "&quot;"); }
