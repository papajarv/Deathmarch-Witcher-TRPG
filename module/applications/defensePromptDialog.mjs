/**
 * defensePromptDialog — modal shown to the target's owner the moment an
 * attacker declares an attack against them. Lets the defender pick how to
 * react before the attacker rolls.
 *
 * Options (button row, dynamic):
 *   - Parry (if defender has an equipped weapon/shield with a parry skill)
 *   - Block (if defender has an equipped shield, or any item with reliability
 *     to spend on a block)
 *   - Dodge (always available — body roll)
 *   - Take it (no defense; attacker just rolls vs base stat)
 *
 * Returns: { action: "parry"|"block"|"dodge"|"none", itemId?: string }
 * — itemId is the embedded item that Parry/Block was declared with. For v1
 * we auto-pick the first eligible weapon/shield; a future pass can let the
 * defender choose which.
 *
 * Auto-resolves to {action:"none"} after `timeoutMs` (default 30s) if the
 * defender doesn't react — so the attacker isn't stuck waiting forever.
 */

import { WEAPON_QUALITIES, ARMOR_QUALITIES } from "../setup/config.mjs";
import { hasWRPerk } from "../api/witcherReborn.mjs";
import { isCombatExtendedEnabled } from "../api/homebrew.mjs";

import { t, tFormat } from "../chrome/lib/i18n.js";
const SYSTEM_ID = "witcher-ttrpg-death-march";

const escAttr = (s) => String(s ?? "")
    .replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("'", "&#39;")
    .replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const escText = (s) => String(s ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/* A weapon/shield is "broken" when it has a Reliability pool
 * (reliability.max > 0) and the current value is 0. Broken items stay
 * EQUIPPED (the user explicitly wants them visible in their slot so the
 * player has to consciously swap or repair) but can't parry / block /
 * attack until repaired. */
function isBroken(item) {
    const max = Number(item?.system?.reliability?.max) || 0;
    if (max <= 0) return false;
    const cur = Number(item?.system?.reliability?.value) || 0;
    return cur <= 0;
}
function parryEligible(item) {
    if (!item?.system?.equipped) return false;
    if (isBroken(item)) return false;
    if (item.type === "weapon") return true;
    if (item.type === "shield") return true;
    if (item.type === "armor" && item.system?.location === "Shield") return true;
    return false;
}
function blockEligible(item) {
    if (!item?.system?.equipped) return false;
    if (isBroken(item)) return false;
    if (item.type === "shield") return true;
    if (item.type === "armor" && item.system?.location === "Shield") return true;
    if (item.type === "weapon") return Number(item.system?.reliability?.value ?? item.system?.reliability) > 0;
    return false;
}

/* Human label for the strike kind shown in the dialog header. Lowercased
 * keys match weaponAttackMixin's `decl.strike` enum. */
const STRIKE_LABELS = {
    normal: "Normal strike",
    strong: "Strong strike",
    fast:   "Fast strike",
    joint:  "Joint attack",
    charge: "Charge",
    feint:  "Feint",
    pommel: "Pommel strike",
    disarm: "Disarm",
    trip:   "Trip",
    grapple:"Grapple",
    pin:    "Pin",
    choke:  "Choke",
    throw:  "Throw",
    pushKick:"Push Kick"
};

/* Which defense actions are valid against each attack kind, per RAW
 * Core p.163-164.  Weapon strikes accept any of the four defenses;
 * grapple / disarm / trip-style attacks accept ONLY dodge or reposition
 * (the prompt's skill-based defenses, which roll Dodge/Escape and
 * Athletics — same skills as RAW's Brawling-counter). */
const DEFENSE_GATE = {
    /* Default — every standard weapon strike. `brawlBlock` is a bare-
     * hands intercept (roll Brawling; on success, the hit is redirected
     * to your arms). Available with or without a weapon in-hand — you
     * can always try to catch the strike on your forearms. */
    normal:   { parry: true, block: true, dodge: true, reposition: true, brawlBlock: true },
    strong:   { parry: true, block: true, dodge: true, reposition: true, brawlBlock: true },
    fast:     { parry: true, block: true, dodge: true, reposition: true, brawlBlock: true },
    joint:    { parry: true, block: true, dodge: true, reposition: true, brawlBlock: true },
    charge:   { parry: true, block: true, dodge: true, reposition: true, brawlBlock: true },
    pommel:   { parry: true, block: true, dodge: true, reposition: true, brawlBlock: true },
    /* Grapple / wrestling chain — RAW p.160. Dodge/Escape only. Brawl-
     * block doesn't fit here — the whole action IS a body-on-body grab. */
    grapple:  { parry: false, block: false, dodge: true, reposition: true, brawlBlock: false },
    pin:      { parry: false, block: false, dodge: true, reposition: true, brawlBlock: false },
    choke:    { parry: false, block: false, dodge: true, reposition: true, brawlBlock: false },
    throw:    { parry: false, block: false, dodge: true, reposition: true, brawlBlock: false },
    pushKick: { parry: false, block: false, dodge: true, reposition: true, brawlBlock: false },
    /* Disarm / Trip (weapon) — RAW p.163: "target rolls Dodge/Escape". */
    disarm:   { parry: false, block: false, dodge: true, reposition: true, brawlBlock: false },
    trip:     { parry: false, block: false, dodge: true, reposition: true, brawlBlock: false },
    /* CE Bash — the attacker charges in with a shoulder / body slam. It's
     * a Brawling roll to hit; there's nothing to parry or block against
     * a body shove, so only dodge / reposition apply. */
    bash:     { parry: false, block: false, dodge: true, reposition: true, brawlBlock: false }
    /* Feint never reaches the defense prompt — it's an opposed
     * Deceit-vs-Awareness check the attacker rolls solo. */
};

const REMOVED_DEFENSE_NOTE = {
    parry: "Parry not allowed against this attack kind (RAW p.163).",
    block: "Block not allowed against this attack kind (RAW p.163)."
};

/* @param {object} opts
 * @param {string}   opts.attackerName
 * @param {string}   opts.weaponName
 * @param {string}   opts.weaponImg
 * @param {Actor}    opts.defenderActor
 * @param {number}   [opts.timeoutMs=30000]
 * @param {string}   [opts.attackKind]        decl.strike — drives the header label
 * @param {number}   [opts.shotIndex]         1-based shot number for multi-shot strikes
 * @param {number}   [opts.totalShots]        total shots in this declaration
 * @param {string[]} [opts.disallowedItemIds] items the defender already committed
 *                                            to a previous shot (joint-attack rule:
 *                                            you can't parry both attacks with one
 *                                            item — Core p.163 sidebar) */
export async function openDefensePrompt({
    attackerName, weaponName, weaponImg, defenderActor, timeoutMs = 30000,
    attackKind = "normal", shotIndex = 1, totalShots = 1, disallowedItemIds = [],
    attackerDamageFlags = null, allowedDefenses = null, requiresShieldCover = false
}) {
    const DialogV2 = foundry?.applications?.api?.DialogV2;
    if (!DialogV2) return { action: "none" };

    /* Witchers Reborn — Viper · Blade Dance: exempt from the joint-attack
     * item-lockout rule. A Blade Dance viper can parry both blades in a
     * joint attack with the same weapon. Note the perk text says "no
     * joint-attack penalty" — the "penalty" in this system's rendering is
     * the item-reuse restriction, not a numeric to-defense malus. */
    const jointExempt = hasWRPerk(defenderActor, "bladeDance");
    const blocked = new Set(jointExempt ? [] : (disallowedItemIds ?? []));
    const items = defenderActor?.items ?? [];
    /* Blocking a ranged / thrown / cast attack requires a shield.
     * RAW: ANY shield works. CE: only shields with cover value ≥ 1 (a
     * CV-0 buckler can't intercept an arrow or a spell). Weapons and
     * non-shield items never intercept in either mode.
     * `requiresShieldCover` is passed by whoever fired the request
     * (weaponAttackMixin sets it when the shot is ranged / thrown;
     * castSpellMixin sets it always). Melee attacks leave it false and
     * any block-eligible item works. */
    const isCast = attackKind === "cast";
    const isShield = (it) => it?.type === "shield"
        || (it?.type === "armor" && it?.system?.location === "Shield");
    const ceOn = isCombatExtendedEnabled();
    const hasCover = (it) => (Number(it?.system?.coverValue) || 0) >= 1;
    // ALL eligible items — a defender with two swords + a shield should be
    // able to pick which one parries / blocks. Previously the dialog grabbed
    // only the first eligible item with .find(), hiding everything else.
    const parryItems = [...items].filter(it => parryEligible(it) && !blocked.has(it.id));
    const blockItems = [...items].filter(it => {
        if (!blockEligible(it) || blocked.has(it.id)) return false;
        if (requiresShieldCover || isCast) {
            if (!isShield(it)) return false;
            /* CE layers the cover-value requirement on top; RAW accepts
             * any equipped shield. */
            if (ceOn && !hasCover(it)) return false;
            return true;
        }
        return true;
    });
    const parryItem = parryItems[0] ?? null;   // legacy fallback when no id encoded
    const blockItem = blockItems[0] ?? null;

    const strikeLabel = STRIKE_LABELS[attackKind] ?? "Attack";
    const shotTag     = totalShots > 1 ? ` (${shotIndex}/${totalShots})` : "";
    const blockedNote = blocked.size > 0
        ? `<div style="margin-top:4px;font-size:0.6875rem;color:#b97;opacity:0.85;">Items used in the previous shot are unavailable for this defense (joint-attack rule).</div>`
        : "";

    /* Re-build the content here so we can include the gate note (which
     * is computed below — moved the content build after the buttons). */
    const buildContent = (extraNotes) => `
        <div class="wdm-defense-prompt" style="display:flex;gap:10px;padding:6px 2px;">
            ${weaponImg ? `<img src="${escAttr(weaponImg)}" alt="" style="width:48px;height:48px;flex:0 0 auto;border:1px solid #6e5224;background:#0a0907;object-fit:contain;"/>` : ""}
            <div style="flex:1 1 auto;font-size:0.75rem;line-height:1.4;">
                <div style="font-family:var(--wdm-font-display,inherit);font-size:0.8125rem;letter-spacing:0.12em;text-transform:uppercase;color:#c8a878;">${escText(attackerName ?? "Attacker")} — ${escText(strikeLabel)}${escText(shotTag)}</div>
                <div style="opacity:0.85;">attacks you with <strong>${escText(weaponName ?? "a weapon")}</strong>.</div>
                <div style="margin-top:6px;font-size:0.6875rem;opacity:0.7;">Pick your defense before they roll.</div>
                ${blockedNote}
                ${extraNotes}
            </div>
        </div>
        <div class="wdm-defense-prompt-mods" style="display:flex;align-items:center;gap:8px;padding:4px 2px 2px;border-top:1px solid #2a2520;margin-top:6px;">
            <label for="wdm-def-extra-mod" style="font-size:0.6875rem;letter-spacing:0.12em;text-transform:uppercase;color:#c8a878;flex:0 0 auto;">Other modifier</label>
            <input id="wdm-def-extra-mod" type="number" name="extraMod" step="1" value="0"
                style="width:64px;padding:2px 4px;background:#0a0907;border:1px solid #6e5224;color:#e5d6b6;font-family:inherit;" />
            <span style="font-size:0.6875rem;opacity:0.6;">applied to the defense roll</span>
        </div>
    `;

    /* Filter the buttons by which defenses are valid against this attack
     * kind (Disarm/Trip/Grapple/Pin/Choke/Throw can't be parried/blocked
     * per RAW p.163-164). Cast-kind uses `allowedDefenses` from the spell
     * item — Igni is `["dodge","block"]` so no parry button; Aard is
     * `["dodge"]` so only dodge/reposition. Empty allowedDefenses on a
     * cast means "no defense clause on the item" — the target just takes
     * it. Default to "allow all" if the strike isn't in the gate map and
     * no allowedDefenses were passed. */
    let baseGate;
    if (Array.isArray(allowedDefenses) && allowedDefenses.length > 0) {
        const allowed = new Set(allowedDefenses.map(String));
        baseGate = {
            parry:      allowed.has("parry"),
            /* Spell "block" clause allows block (shield only, filtered
             * above). Spell "dodge" clause enables BOTH dodge and
             * reposition — both are DEX-based evasion. */
            block:      allowed.has("block"),
            dodge:      allowed.has("dodge"),
            reposition: allowed.has("dodge"),
            /* No brawlBlock against a spell — you can't punch a fireball. */
            brawlBlock: false
        };
    } else if (Array.isArray(allowedDefenses) && allowedDefenses.length === 0 && isCast) {
        /* Cast with no defense clause — no defense possible; only
         * "take it" is available. */
        baseGate = { parry: false, block: false, dodge: false, reposition: false, brawlBlock: false };
    } else {
        baseGate = DEFENSE_GATE[attackKind] ?? { parry: true, block: true, dodge: true, reposition: true };
        /* CE Combat Extended (2026-07-03) grapple-flow gate overrides.
         *
         *   Grapple  — defender picks between Dodge/Escape,
         *              Reposition, OR Brawling (CE spec: "Roll Brawling
         *              vs target's Brawling, or Dodge Escape, or
         *              Reposition to try and grapple them.").
         *              brawlBlock is our engine-side Brawling defense —
         *              enable it under CE.
         *   Pin / Choke / Throw / Ride — CE spec: "Follow-up actions
         *              such as pin, ride, etc etc, will always be only
         *              resisted with brawling." Dodge + Reposition are
         *              REMOVED and only brawlBlock remains, matching
         *              the "close-in, wrestling continues" flavor.
         *
         * Guarded on the master extendedCombat toggle so RAW behavior
         * is untouched when CE is off. */
        if (ceOn) {
            if (attackKind === "grapple") {
                baseGate = { ...baseGate, brawlBlock: true };
            } else if (attackKind === "pin" || attackKind === "choke"
                    || attackKind === "throw" || attackKind === "ride") {
                baseGate = { parry: false, block: false, dodge: false, reposition: false, brawlBlock: true };
            }
        }
    }
    /* Ranged / thrown attacks can't be parried in RAW (Core: parry is a
     * melee response). Only shield-block (see item filter above) and
     * dodge/reposition work. Same rule for CE. A future witcher-only
     * "arrow parry" perk would flip a bypass flag here; not implemented
     * yet. `requiresShieldCover` is the same signal that gates shield-
     * only block, so the two guards fire together.
     *
     * We also FORCE-ENABLE block here. Weapon "throw" strikes and
     * wrestling "throw" actions share the attackKind:"throw" — the
     * DEFENSE_GATE entry above was written for the wrestling variant
     * and hard-disables block, which would strand the shield-block
     * intent for a hurled dagger. `requiresShieldCover` is only set
     * for genuine ranged/thrown weapon shots (weaponAttackMixin) and
     * casts (castSpellMixin) — never for wrestling — so it's safe to
     * override baseGate.block here. The item filter above already
     * restricts the block button to shields (RAW) or CV≥1 shields
     * (CE). */
    if (requiresShieldCover) {
        baseGate = { ...baseGate, parry: false, block: true, brawlBlock: false };
    }
    /* Quality-driven override: the attacker's weapon may carry a damageFlag
     * that strips a defense category (Crushing Force / Hefty / `deniesParry`
     * denies the parry response per RAW Core p.165 + EO p.7). The flag flows
     * in via `attackerDamageFlags` from the attack pipeline.
     *
     * EO counter rule: if any of the defender's would-be parry items
     * carries Sturdy / Very Sturdy (counterHefty) — or Very Sturdy
     * (counterCrushingForce) — parry is RE-ENABLED, restricted to those
     * specific items. We filter parryItems to keep only the counterers
     * in that case; the parry buttons that get rendered for the user
     * are then only the legitimate ones. */
    let parryGateLocal = baseGate.parry && !attackerDamageFlags?.deniesParry;
    const gate = { ...baseGate, parry: parryGateLocal };
    if (baseGate.parry && attackerDamageFlags?.deniesParry) {
        /* Pull the union catalog so we can identify counterHefty items
         * regardless of whether they're weapons or shields. */
        const allCat = { ...WEAPON_QUALITIES, ...ARMOR_QUALITIES };
        const isCountering = (it) => {
            const qs = it?.system?.effective?.qualities ?? it?.system?.qualities ?? [];
            return qs.some(q => allCat[q]?.counterHefty || allCat[q]?.counterCrushingForce);
        };
        const counterers = parryItems.filter(isCountering);
        if (counterers.length > 0) {
            /* Restrict parryItems to the counterers + re-enable parry */
            parryItems.length = 0;
            for (const it of counterers) parryItems.push(it);
            gate.parry = true;
        }
    }
    /* Buttons are organized as one COLUMN per action kind (Parry / Block /
     * Dodge / Reposition / Take it). Multiple eligible parry or block items
     * stack inside their own column so the row stays visually aligned: each
     * kind sits in its own slot, and only the variant cells grow downward.
     *
     * We keep a flat `buttons` list as a DialogV2 fallback (its footer is
     * hidden via CSS — the interactive buttons render inline inside the
     * content). This lets DialogV2 still satisfy its API requirement
     * (non-empty buttons array) without showing a duplicate row. */
    const cols = { parry: [], block: [], dodge: [], reposition: [], none: [] };
    const buttons = [];
    const pushBtn = (kind, b) => { buttons.push(b); cols[kind].push(b); };
    if (gate.parry) {
        if (parryItems.length <= 1) {
            // 0 or 1 eligible — single button (disabled if none)
            pushBtn("parry", {
                action: "parry",
                label:  parryItem ? `Parry (${parryItem.name})` : "Parry",
                disabled: !parryItem,
                icon: "fa-solid fa-shield-halved"
            });
        } else {
            // 2+ eligible — one button per item. Action carries the itemId
            // after a colon (`parry:abc123`) so the result handler can route.
            for (const it of parryItems) {
                pushBtn("parry", {
                    action: `parry:${it.id}`,
                    label:  `Parry — ${it.name}`,
                    icon:   "fa-solid fa-shield-halved"
                });
            }
        }
    }
    if (gate.block) {
        if (blockItems.length <= 1) {
            pushBtn("block", {
                action: "block",
                label:  blockItem ? `Block (${blockItem.name})` : "Block",
                disabled: !blockItem,
                icon: "fa-solid fa-shield"
            });
        } else {
            for (const it of blockItems) {
                pushBtn("block", {
                    action: `block:${it.id}`,
                    label:  `Block — ${it.name}`,
                    icon:   "fa-solid fa-shield"
                });
            }
        }
    }
    if (gate.dodge) {
        pushBtn("dodge", { action: "dodge", label: "Dodge", icon: "fa-solid fa-person-running" });
    }
    /* Brawling defense — two flavors sharing the `brawlBlock` engine:
     *
     *   - "Arm Block" (RAW + CE, vs weapon strikes): bare-hands intercept,
     *     REF + Brawling roll; the incoming hit is redirected to a random
     *     arm — damage applies against arm SP instead of the location the
     *     attacker rolled.
     *   - "Brawling" (CE only, vs the grapple family): CE spec allows the
     *     defender to resist a grapple attempt — or a follow-up pin / choke
     *     / throw / ride — by rolling their own Brawling opposed to the
     *     attacker's. Same engine as Arm Block on our side; the label
     *     changes so the player understands they're wrestling out rather
     *     than tanking a hit on the forearm.
     *
     * Nested UNDER the Block column so the layout stays compact (no extra
     * column that would overflow the dialog width). */
    if (gate.brawlBlock) {
        const isGrappleFamily = ["grapple", "pin", "choke", "throw", "ride"].includes(attackKind);
        pushBtn("block", {
            action: "brawlBlock",
            label:  isGrappleFamily ? "Brawling" : "Arm Block",
            icon:   "fa-solid fa-hand-fist"
        });
    }
    if (gate.reposition) {
        /* Reposition round-cap: total meters repositioned across all
         * defenses this round is bounded by the defender's SPD.
         * Half-SPD is the per-defense allowance; SPD is the per-round
         * ceiling. When the round budget is exhausted, disable the
         * button rather than letting the click open a doomed overlay. */
        const spd = Number(defenderActor?.system?.stats?.spd?.value) || 0;
        const priorReposition = Number(defenderActor?.system?.combatRound?.repositionMeters) || 0;
        const roundRemaining = spd > 0 ? Math.max(0, spd - priorReposition) : Infinity;
        const halfSpd = Math.floor(spd / 2);
        const canReposition = spd > 0 && roundRemaining > 0 && halfSpd > 0;
        pushBtn("reposition", {
            action:   "reposition",
            label:    spd > 0
                ? `Reposition (${priorReposition}/${spd}m)`
                : "Reposition",
            icon:     "fa-solid fa-arrows-up-down-left-right",
            disabled: !canReposition
        });
    }
    pushBtn("none", { action: "none", label: "Take it", default: true, icon: "fa-solid fa-xmark" });

    /* Render one button (matches the kind-column layout — used in the inline
     * action row, not DialogV2's hidden footer). */
    const renderInlineBtn = (b) => `
        <button type="button" class="wdm-defense-btn${b.default ? " default" : ""}"
            data-action="${escAttr(b.action)}"${b.disabled ? " disabled" : ""}>
            <i class="${escAttr(b.icon)}"></i>
            <span>${escText(b.label)}</span>
        </button>`;
    const renderCol = (kind) => {
        const items = cols[kind];
        if (!items.length) return "";
        return `<div class="wdm-defense-col" data-kind="${kind}">${items.map(renderInlineBtn).join("")}</div>`;
    };
    const actionsHtml = `
        <div class="wdm-defense-actions">
            ${renderCol("parry")}
            ${renderCol("block")}
            ${renderCol("dodge")}
            ${renderCol("reposition")}
            ${renderCol("none")}
        </div>`;

    /* Append a small note explaining why parry/block are missing for
     * gated attacks (RAW reference). Quality-driven denial gets its own
     * line so the defender knows the attack kind isn't the cause. */
    const kindGated   = !baseGate.parry || !baseGate.block;
    const qualityGate = baseGate.parry && !gate.parry;   // parry stripped by deniesParry
    const spdForNote  = Number(defenderActor?.system?.stats?.spd?.value) || 0;
    const priorRepositionForNote = Number(defenderActor?.system?.combatRound?.repositionMeters) || 0;
    const repositionCapReached = spdForNote > 0 && priorRepositionForNote >= spdForNote;
    /* Build the "valid defenses" hint from the actual gate — under CE,
     * grapple-family attacks add Brawling as a valid response (grapple
     * still allows Dodge + Reposition; pin/choke/throw/ride drop those
     * and leave Brawling only). RAW mode keeps the original wording. */
    const validDefenseNames = [
        gate.dodge && "Dodge",
        gate.reposition && "Reposition",
        gate.brawlBlock && "Brawling"
    ].filter(Boolean);
    const validDefenseText = validDefenseNames.length
        ? validDefenseNames.join(" / ")
        : "Dodge / Reposition";
    const gateNote = [
        kindGated
            ? `<div style="margin-top:4px;font-size:0.6875rem;color:#b97;opacity:0.85;">Only ${escText(validDefenseText)} are valid against ${escText(STRIKE_LABELS[attackKind] ?? "this attack")} (RAW Core p.163-164).</div>`
            : "",
        qualityGate
            ? `<div style="margin-top:4px;font-size:0.6875rem;color:#b97;opacity:0.85;">Parry denied — the attacker's weapon cannot be parried (e.g. Crushing Force).</div>`
            : "",
        gate.reposition && spdForNote > 0
            ? (repositionCapReached
                ? `<div style="margin-top:4px;font-size:0.6875rem;color:#b97;opacity:0.85;">Reposition cap reached — ${priorRepositionForNote} of ${spdForNote}m used this round.</div>`
                : `<div style="margin-top:4px;font-size:0.6875rem;opacity:0.65;">Reposition: ${priorRepositionForNote} / ${spdForNote}m used this round (half-SPD ${Math.floor(spdForNote/2)}m per defense).</div>`)
            : ""
    ].join("");

    let dialog = null;
    let resolved = false;
    return await new Promise((resolve) => {
        const finalize = (result) => {
            if (resolved) return;
            resolved = true;
            try { dialog?.close?.({ force: true }); } catch (_) { /* already closed */ }
            resolve(result);
        };
        const timer = setTimeout(() => finalize({ action: "none", timedOut: true }), timeoutMs);

        /* Translate a raw action string ("parry", "parry:<id>", "dodge", "none")
         * into the shaped result the caller expects, folding in the extra-mod
         * input. Shared by both the inline-button click handler (the visible
         * path) and the DialogV2 footer fallback (hidden — only reachable if
         * someone overrides the CSS that hides it). */
        const buildResult = (raw, root) => {
            const result = { action: raw };
            const colon = raw.indexOf(":");
            if (colon > 0) {
                result.action = raw.slice(0, colon);
                result.itemId = raw.slice(colon + 1);
            } else {
                if (result.action === "parry") result.itemId = parryItem?.id ?? null;
                if (result.action === "block") result.itemId = blockItem?.id ?? null;
            }
            if (result.action !== "none") {
                const v = root?.querySelector?.('[name="extraMod"]')?.value;
                const n = Math.round(Number(v) || 0);
                if (n) result.extraMod = n;
            }
            return result;
        };

        DialogV2.wait({
            window: {
                title: tFormat("WITCHER.Dialog.Defense.Incoming", { strike: strikeLabel, shot: shotTag, weapon: weaponName ?? "" }, "Incoming {strike}{shot} — {weapon}").trim(),
                icon: "fa-solid fa-shield-halved"
            },
            classes: ["wdm-defense-prompt-dialog"],
            content: buildContent(gateNote) + actionsHtml,
            buttons,
            rejectClose: false,
            render: (_event, dlg) => {
                dialog = dlg;
                const root = dlg.element;
                /* Wire the inline kind-column buttons. Clicking one resolves
                 * the outer Promise (via finalize) and closes the dialog —
                 * the hidden DialogV2 footer never participates. */
                root.querySelectorAll(".wdm-defense-btn").forEach(btn => {
                    btn.addEventListener("click", (ev) => {
                        ev.preventDefault();
                        ev.stopPropagation();
                        if (btn.disabled) return;
                        finalize(buildResult(btn.dataset.action || "none", root));
                    });
                });
            }
        }).then(action => {
            clearTimeout(timer);
            // DialogV2 footer is hidden — this path only fires if a user/style
            // override re-exposes it, or DialogV2 itself synthesises a default.
            finalize(buildResult(action || "none", dialog?.element));
        }).catch(() => {
            clearTimeout(timer);
            finalize({ action: "none" });
        });
    });
}
