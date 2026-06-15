/**
 * Witcher Overhaul UI · critical-wound roller
 *
 * Combat-bar "Critical" button → this module's `openCriticalDialog()`.
 * The roller's only job is the RAW dice: it determines the HIT LOCATION and
 * whether the wound is LESSER or GREATER (severity is chosen in the dialog).
 * The wound itself — name, effect text, healing — lives entirely in the
 * assigned compendium and is fished out by those three dimensions, so no
 * wound data is hard-wired here (swap packs freely; see resolveWoundEntry).
 *
 *   Beat By  Level       Bonus DMG
 *      7     Simple        +3
 *     10     Complex       +5
 *     13     Difficult     +8
 *     15     Deadly       +10
 *
 * Unaimed: 2d6 (+2 if Balanced) → location + lesser/greater per the table
 *   12   → head greater    11   → head lesser
 *   9-10 → torso greater   6-8  → torso lesser
 *   4-5  → arm (left/right coin flip)
 *   2-3  → leg (left/right coin flip)
 *
 * Aimed (head/torso): 1d6 (+1 if Balanced).  1-4 → lesser, 5-6 → greater.
 * Aimed (arm/leg): no roll, side chosen in the dialog.
 *
 * Chat message lists severity / location / bonus damage and shows an
 * "Apply Critical Wound" button.  Clicking it pulls the matching item from
 * the compendium assigned in the system settings (`criticalWoundsPack`),
 * matched by region + severity + lesser/greater variant rather than by name,
 * then applies it to the chosen actor (stamping the exact sided location).
 * Target picker shows a dropdown if 2+ tokens controlled or 2+ owned actors.
 */

import { isAdrenalineEnabled } from "../../api/adrenaline.mjs";

/**
 * Scoring a critical banks 1 adrenaline for the attacker (RAW Core p.175-176:
 * one die per critical hit, pool capped at BODY). The crit macro is rolled by
 * the attacker, so the grant lands on the actor the dialog was opened for.
 * No-ops when the optional rule is off or the actor has no adrenaline pool.
 */
async function grantCritAdrenaline(actor) {
    if (!actor || !isAdrenalineEnabled()) return;
    const cur = Number(actor.system?.adrenaline?.value);
    if (!Number.isFinite(cur)) return;                 // no adrenaline schema (e.g. some actor types)
    const cap = Number(actor.system?.stats?.body?.value) || 0;
    const next = Math.min(cur + 1, cap);
    if (next === cur) return;                           // already at the BODY cap
    try {
        await actor.update({ "system.adrenaline.value": next });
        ui.notifications?.info(`${actor.name} gains 1 adrenaline (${next}/${cap}).`);
    } catch (err) {
        console.warn("witcher-ttrpg-death-march | crit adrenaline grant failed", err);
    }
}

const SEVERITY = {
    simple:    { label: 'Simple',    beatBy: 7,  bonus: 3 },
    complex:   { label: 'Complex',   beatBy: 10, bonus: 5 },
    difficult: { label: 'Difficult', beatBy: 13, bonus: 8 },
    deadly:    { label: 'Deadly',    beatBy: 15, bonus: 10 }
};

function lookupUnaimed(roll) {
    if (roll >= 12)  return { location: 'head',  variant: 'greater' };
    if (roll === 11) return { location: 'head',  variant: 'lesser' };
    if (roll >= 9)   return { location: 'torso', variant: 'greater' };
    if (roll >= 6)   return { location: 'torso', variant: 'lesser' };
    if (roll >= 4)   return { location: 'arm',   variant: null };
    return                  { location: 'leg',   variant: null };
}

/**
 * Find the critical-wound item matching a roll in the GM-assigned compendium
 * (system setting `criticalWoundsPack`). The wound's identity lives entirely
 * in the compendium — this just fishes it out by region (un-sided) + severity
 * + lesser/greater. Head/torso carry both variants; limbs have just one, so
 * the variant flag is ignored when only one match exists.
 *
 * Returns `{ pack, entry }`: `pack` is null when none is assigned, `entry`
 * (an index entry) is null when the pack holds no matching wound.
 */
async function resolveWoundEntry(loc, severity, lesser) {
    const packId = game.settings.get('witcher-ttrpg-death-march', 'criticalWoundsPack');
    const pack = packId ? game.packs.get(packId) : null;
    if (!pack) return { pack: null, entry: null };
    const idx = await pack.getIndex({ fields: ['system.location', 'system.criticalLevel', 'system.lesserEffect'] });
    const region = locRegion(loc);
    const cell = idx.filter(e =>
        e.system?.criticalLevel === severity &&
        locRegion(e.system?.location ?? '') === region);
    const entry = cell.find(e => !!e.system?.lesserEffect === lesser) ?? cell[0] ?? null;
    return { pack, entry };
}

function locRegion(loc) {
    if (loc === 'head' || loc === 'torso') return loc;
    if (loc.endsWith('Arm')) return 'arm';
    if (loc.endsWith('Leg')) return 'leg';
    return loc;
}

const LOC_LABEL = {
    head: 'Head', torso: 'Torso',
    rightArm: 'Right Arm', leftArm: 'Left Arm',
    rightLeg: 'Right Leg', leftLeg: 'Left Leg'
};

/* ============================================================================
   Dialog → roll → chat
   ============================================================================ */

export async function openCriticalDialog(actor = null) {
    const DialogV2 = foundry.applications.api.DialogV2;

    const sevOpts = Object.entries(SEVERITY)
        .map(([k, v]) => `<option value="${k}">${v.label} — beat by ${v.beatBy}+ · +${v.bonus} bonus dmg</option>`)
        .join('');

    const locOpts = `
        <option value="head">Head</option>
        <option value="torso">Torso</option>
        <option value="rightArm">Right Arm</option>
        <option value="leftArm">Left Arm</option>
        <option value="rightLeg">Right Leg</option>
        <option value="leftLeg">Left Leg</option>
    `;

    const content = `
        <form style="display:flex; flex-direction:column; gap:8px;">
            <label><input type="checkbox" name="aimed"> Aimed Attack</label>
            <div class="form-group">
                <label>Severity</label>
                <select name="severity">${sevOpts}</select>
            </div>
            <div class="form-group" data-loc-row style="display:none;">
                <label>Location</label>
                <select name="location">${locOpts}</select>
            </div>
            <label><input type="checkbox" name="balanced"> Balanced Weapon (+1 aimed / +2 unaimed)</label>
        </form>
    `;

    const result = await DialogV2.prompt({
        window: { title: 'Roll Critical Wound' },
        content,
        modal: true,
        ok: {
            label: 'Roll',
            callback: (event, button) => {
                const f = button.form;
                return {
                    aimed:    f.elements.aimed.checked,
                    severity: f.elements.severity.value,
                    location: f.elements.location.value,
                    balanced: f.elements.balanced.checked
                };
            }
        },
        rejectClose: true,
        render: (event, dialog) => {
            const html = dialog.element ?? dialog;
            const aimed = html.querySelector('input[name="aimed"]');
            const row   = html.querySelector('[data-loc-row]');
            const toggle = () => row.style.display = aimed.checked ? '' : 'none';
            aimed.addEventListener('change', toggle);
            toggle();
        }
    }).catch(() => null);

    if (!result) return;

    const { aimed, severity, location, balanced } = result;
    const sev = SEVERITY[severity];

    let rollFormula, rollText, variant = null, locationFinal;
    if (aimed) {
        locationFinal = location;
        const region = locRegion(location);
        if (region === 'head' || region === 'torso') {
            const formula = balanced ? '1d6+1' : '1d6';
            const r = await new Roll(formula).evaluate();
            await game.dice3d?.showForRoll(r, game.user, true);
            variant = r.total >= 5 ? 'greater' : 'lesser';
            rollFormula = formula;
            rollText = `${r.total} (raw ${r.dice[0].results.map(d => d.result).join('+')}${balanced ? '+1' : ''}) → ${variant}`;
        } else {
            rollFormula = '—';
            rollText = `Aimed ${region}, no roll needed`;
        }
    } else {
        const formula = balanced ? '2d6+2' : '2d6';
        const r = await new Roll(formula).evaluate();
        await game.dice3d?.showForRoll(r, game.user, true);
        const total = Math.min(12, r.total);
        const looked = lookupUnaimed(total);
        if (looked.location === 'arm') {
            const side = await new Roll('1d2').evaluate();
            locationFinal = side.total === 1 ? 'leftArm' : 'rightArm';
        } else if (looked.location === 'leg') {
            const side = await new Roll('1d2').evaluate();
            locationFinal = side.total === 1 ? 'leftLeg' : 'rightLeg';
        } else {
            locationFinal = looked.location;
        }
        variant = looked.variant;
        rollFormula = formula;
        rollText = `${r.total} (raw ${r.dice[0].results.map(d => d.result).join('+')}${balanced ? '+2' : ''})${total !== r.total ? ` → clamped ${total}` : ''} → ${looked.location}`;
    }

    const lesser = variant === 'lesser';

    const variantRow = variant
        ? `<div><b>Variant:</b> ${variant}</div>`
        : '';

    const sideSuffix =
        locationFinal === 'leftArm' || locationFinal === 'leftLeg'   ? ' (Left)'  :
        locationFinal === 'rightArm' || locationFinal === 'rightLeg' ? ' (Right)' : '';

    const locLabel = LOC_LABEL[locationFinal] ?? locationFinal;

    // Preview the wound name from the assigned compendium (best effort — the
    // actual lookup happens again at Apply against the chosen target's world).
    const { entry: previewEntry } = await resolveWoundEntry(locationFinal, severity, lesser);
    const woundName = previewEntry
        ? `${previewEntry.name}${sideSuffix}`
        : `${locLabel}${variant ? ` (${variant})` : ''} — no wound assigned`;

    const html = `
        <div style="line-height:1.4;">
            <h3 style="margin:0 0 6px 0;">${sev.label} Critical — ${woundName}</h3>
            <div><b>Location:</b> ${locLabel}</div>
            ${variantRow}
            <div><b>Beat defense by:</b> ${sev.beatBy}+</div>
            <div><b>Bonus damage:</b> +${sev.bonus}</div>
            <div><b>Roll:</b> ${rollFormula} → ${rollText}</div>
            <button type="button" data-action="wou-apply-crit"
                    data-location="${locationFinal}"
                    data-severity="${severity}"
                    data-lesser="${lesser}"
                    data-actor-uuid="${actor?.uuid ?? ''}"
                    style="margin-top:8px; padding:6px 12px; cursor:pointer; width:100%;">
                Apply Critical Wound
            </button>
        </div>
    `;

    await ChatMessage.create({
        speaker: actor ? ChatMessage.getSpeaker({ actor }) : ChatMessage.getSpeaker(),
        content: html,
        flags: { 'witcher-ttrpg-death-march': { severity, location: locationFinal, variant } }
    });

    // Scoring the crit banks 1 adrenaline for the roller (optional rule).
    await grantCritAdrenaline(actor);
}

/* ============================================================================
   Apply button → resolve target, fetch from compendium, attach
   ============================================================================ */

async function applyCritFromButton(button) {
    const loc   = button.dataset.location;
    const sev   = button.dataset.severity;
    const lesser= button.dataset.lesser === 'true';

    const DialogV2 = foundry.applications.api.DialogV2;

    const promptPick = async (candidates, defaultId) => {
        const opts = candidates
            .map(a => `<option value="${a.id}"${a.id === defaultId ? ' selected' : ''}>${a.name} <em>(${a.type})</em></option>`)
            .join('');
        const chosen = await DialogV2.prompt({
            window: { title: 'Apply Critical To...' },
            content: `<form>
                <div class="form-group">
                    <label>Target</label>
                    <select name="actorId">${opts}</select>
                </div>
            </form>`,
            modal: true,
            ok: {
                label: 'Apply',
                callback: (event, button) => button.form.elements.actorId.value
            },
            rejectClose: false
        }).catch(() => null);
        return chosen ? game.actors.get(chosen) : null;
    };

    // If the crit was rolled from a specific actor's sheet (monster sheet,
    // dock-assigned character), that actor is the intended target — apply
    // straight to it, skipping the token/owned/assigned fallback chain.
    // fromUuidSync resolves both world actors and synthetic token actors.
    let actor;
    const explicitUuid = button.dataset.actorUuid;
    if (explicitUuid) {
        let explicit = null;
        try { explicit = fromUuidSync(explicitUuid); } catch (_) { explicit = null; }
        if (explicit?.isOwner) actor = explicit;
    }

    const controlled = !actor ? (canvas.tokens?.controlled ?? []) : [];
    if (actor) {
        /* resolved from the rolling actor — nothing more to pick */
    } else if (controlled.length === 1) {
        actor = controlled[0].actor;
    } else if (controlled.length >= 2) {
        actor = await promptPick(controlled.map(t => t.actor), controlled[0].actor.id);
        if (!actor) return;
    } else {
        const owned = game.actors.contents
            .filter(a => a.isOwner && ['character', 'monster'].includes(a.type))
            .sort((a, b) => a.name.localeCompare(b.name));
        if (owned.length === 1) {
            actor = owned[0];
        } else if (owned.length >= 2) {
            actor = await promptPick(owned, game.user.character?.id);
            if (!actor) return;
        } else {
            actor = game.user.character;
        }
    }
    if (!actor) {
        ui.notifications.error('No actor selected. Select a token or own an actor.');
        return;
    }

    const { pack, entry } = await resolveWoundEntry(loc, sev, lesser);
    if (!pack) {
        ui.notifications.error('No Critical Wounds compendium assigned — set one in the system settings.');
        return;
    }
    if (!entry) {
        ui.notifications.error(`No ${sev} ${locRegion(loc)} wound found in "${pack.metadata.label}".`);
        return;
    }
    const doc = await pack.getDocument(entry._id);
    const data = doc.toObject();
    // Defensive: drop the compendium source _ids before embedding. The item _id
    // is regenerated by the server anyway, but nested effect _ids are NOT — two
    // wounds whose effects share a derived id (same effect name in the pack)
    // would otherwise carry identical effect _ids. Fresh ids keep them distinct.
    delete data._id;
    if (Array.isArray(data.effects)) for (const e of data.effects) delete e._id;
    if (loc) data.system.location = loc;
    data.system.criticalLevel = sev;
    data.system.lesserEffect = lesser;

    await actor.createEmbeddedDocuments('Item', [data]);
    ui.notifications.info(`Applied "${entry.name}" to ${actor.name}.`);

    // Taking a Critical Wound forces a Stun save (Core p.159). Route through
    // the same prompt the dock / sheets use so it's one unified flow: it asks
    // for a situational modifier and rollStunSave toggles Stunned (apply on
    // fail, clear on pass).
    try {
        await actor.promptSave?.({ type: "stun" });
    } catch (err) {
        console.warn('witcher-ttrpg-death-march | crit-wound stun save failed', err);
    }
}

/* ============================================================================
   Chat-button wiring
   ============================================================================ */

export function installCritChatHandler() {
    Hooks.on('renderChatMessageHTML', (msg, el) => {
        const btn = el.querySelector?.('button[data-action="wou-apply-crit"]');
        if (btn && !btn.dataset.wired) {
            btn.dataset.wired = '1';
            btn.addEventListener('click', () => applyCritFromButton(btn));
        }
    });
}
