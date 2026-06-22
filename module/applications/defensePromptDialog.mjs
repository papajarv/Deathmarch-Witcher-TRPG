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
    /* Default — every standard weapon strike. */
    normal:   { parry: true, block: true, dodge: true, reposition: true },
    strong:   { parry: true, block: true, dodge: true, reposition: true },
    fast:     { parry: true, block: true, dodge: true, reposition: true },
    joint:    { parry: true, block: true, dodge: true, reposition: true },
    charge:   { parry: true, block: true, dodge: true, reposition: true },
    pommel:   { parry: true, block: true, dodge: true, reposition: true },
    /* Grapple / wrestling chain — RAW p.160. Dodge/Escape only. */
    grapple:  { parry: false, block: false, dodge: true, reposition: true },
    pin:      { parry: false, block: false, dodge: true, reposition: true },
    choke:    { parry: false, block: false, dodge: true, reposition: true },
    throw:    { parry: false, block: false, dodge: true, reposition: true },
    pushKick: { parry: false, block: false, dodge: true, reposition: true },
    /* Disarm / Trip (weapon) — RAW p.163: "target rolls Dodge/Escape". */
    disarm:   { parry: false, block: false, dodge: true, reposition: true },
    trip:     { parry: false, block: false, dodge: true, reposition: true }
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
    attackKind = "normal", shotIndex = 1, totalShots = 1, disallowedItemIds = []
}) {
    const DialogV2 = foundry?.applications?.api?.DialogV2;
    if (!DialogV2) return { action: "none" };

    const blocked = new Set(disallowedItemIds ?? []);
    const items = defenderActor?.items ?? [];
    // ALL eligible items — a defender with two swords + a shield should be
    // able to pick which one parries / blocks. Previously the dialog grabbed
    // only the first eligible item with .find(), hiding everything else.
    const parryItems = [...items].filter(it => parryEligible(it) && !blocked.has(it.id));
    const blockItems = [...items].filter(it => blockEligible(it) && !blocked.has(it.id));
    const parryItem = parryItems[0] ?? null;   // legacy fallback when no id encoded
    const blockItem = blockItems[0] ?? null;

    const strikeLabel = STRIKE_LABELS[attackKind] ?? "Attack";
    const shotTag     = totalShots > 1 ? ` (${shotIndex}/${totalShots})` : "";
    const blockedNote = blocked.size > 0
        ? `<div style="margin-top:4px;font-size:11px;color:#b97;opacity:0.85;">Items used in the previous shot are unavailable for this defense (joint-attack rule).</div>`
        : "";

    /* Re-build the content here so we can include the gate note (which
     * is computed below — moved the content build after the buttons). */
    const buildContent = (extraNotes) => `
        <div class="wdm-defense-prompt" style="display:flex;gap:10px;padding:6px 2px;">
            ${weaponImg ? `<img src="${escAttr(weaponImg)}" alt="" style="width:48px;height:48px;flex:0 0 auto;border:1px solid #6e5224;background:#0a0907;object-fit:contain;"/>` : ""}
            <div style="flex:1 1 auto;font-size:12px;line-height:1.4;">
                <div style="font-family:var(--wdm-font-display,inherit);font-size:13px;letter-spacing:0.12em;text-transform:uppercase;color:#c8a878;">${escText(attackerName ?? "Attacker")} — ${escText(strikeLabel)}${escText(shotTag)}</div>
                <div style="opacity:0.85;">attacks you with <strong>${escText(weaponName ?? "a weapon")}</strong>.</div>
                <div style="margin-top:6px;font-size:11px;opacity:0.7;">Pick your defense before they roll.</div>
                ${blockedNote}
                ${extraNotes}
            </div>
        </div>
    `;

    /* Filter the buttons by which defenses are valid against this attack
     * kind (Disarm/Trip/Grapple/Pin/Choke/Throw can't be parried/blocked
     * per RAW p.163-164).  Default to "allow all" if the strike isn't in
     * the gate map. */
    const gate = DEFENSE_GATE[attackKind] ?? { parry: true, block: true, dodge: true, reposition: true };
    const buttons = [];
    if (gate.parry) {
        if (parryItems.length <= 1) {
            // 0 or 1 eligible — single button (disabled if none)
            buttons.push({
                action: "parry",
                label:  parryItem ? `Parry (${parryItem.name})` : "Parry",
                disabled: !parryItem,
                icon: "fa-solid fa-shield-halved"
            });
        } else {
            // 2+ eligible — one button per item. Action carries the itemId
            // after a colon (`parry:abc123`) so the result handler can route.
            for (const it of parryItems) {
                buttons.push({
                    action: `parry:${it.id}`,
                    label:  `Parry — ${it.name}`,
                    icon:   "fa-solid fa-shield-halved"
                });
            }
        }
    }
    if (gate.block) {
        if (blockItems.length <= 1) {
            buttons.push({
                action: "block",
                label:  blockItem ? `Block (${blockItem.name})` : "Block",
                disabled: !blockItem,
                icon: "fa-solid fa-shield"
            });
        } else {
            for (const it of blockItems) {
                buttons.push({
                    action: `block:${it.id}`,
                    label:  `Block — ${it.name}`,
                    icon:   "fa-solid fa-shield"
                });
            }
        }
    }
    if (gate.dodge) {
        buttons.push({ action: "dodge",    label: "Dodge",    icon: "fa-solid fa-person-running" });
    }
    if (gate.reposition) {
        buttons.push({ action: "reposition", label: "Reposition", icon: "fa-solid fa-arrows-up-down-left-right" });
    }
    buttons.push({ action: "none", label: "Take it", default: true, icon: "fa-solid fa-xmark" });

    /* Append a small note explaining why parry/block are missing for
     * gated attacks (RAW reference). */
    const gateNote = (!gate.parry || !gate.block)
        ? `<div style="margin-top:4px;font-size:11px;color:#b97;opacity:0.85;">Only Dodge / Reposition are valid against ${escText(STRIKE_LABELS[attackKind] ?? "this attack")} (RAW Core p.163-164).</div>`
        : "";

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

        DialogV2.wait({
            window: {
                title: `Incoming ${strikeLabel}${shotTag} — ${weaponName ?? ""}`.trim(),
                icon: "fa-solid fa-shield-halved"
            },
            classes: ["wdm-defense-prompt-dialog"],
            content: buildContent(gateNote),
            buttons,
            rejectClose: false,
            render: (_event, dlg) => { dialog = dlg; }
        }).then(action => {
            clearTimeout(timer);
            const raw = action || "none";
            const result = { action: raw };
            // Multi-button form encodes `${action}:${itemId}` so we can route
            // to the specific chosen weapon/shield. Strip the suffix back.
            const colon = raw.indexOf(":");
            if (colon > 0) {
                result.action = raw.slice(0, colon);
                result.itemId = raw.slice(colon + 1);
            } else {
                if (result.action === "parry") result.itemId = parryItem?.id ?? null;
                if (result.action === "block") result.itemId = blockItem?.id ?? null;
            }
            finalize(result);
        }).catch(() => {
            clearTimeout(timer);
            finalize({ action: "none" });
        });
    });
}
