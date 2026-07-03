import { t, tFormat } from "../lib/i18n.js";
import { FUMBLE_TABLE as FUMBLES } from "../../mechanics/fumbleTable.mjs";
/**
 * Fumble lookup dialog.
 *
 * Hooked to the dock's combat-mode "Fumble" sign.  Prompts the user to
 * pick a fumble category, rolls 1d10, looks up the matching row from the
 * RAW Witcher TRPG fumble tables, and posts the result to chat as a real
 * roll message (so DSN dice animate and the d10 shows up as a normal
 * roll line).
 *
 * Tables live in mechanics/fumbleTable.mjs — this dialog and the
 * mechanics/autoFumble.mjs auto-roll flow share that single source.
 * Two categories share the same underlying table per RAW: unarmed
 * attack and unarmed defense route to different fiction with the same
 * mechanical outcomes.
 */

/**
 * Elemental Fumble Effect table (paraphrased from RAW).  When a magic fumble
 * tells you to "suffer an elemental fumble effect", the element is whatever
 * you were channelling — the player picks it here.  Every result deals 1
 * damage per point you fumbled by; the element adds the rider condition.
 */
const ELEMENTAL_FUMBLES = {
  mixed: {
    label: "Mixed / Chaos",
    effect: "Raw chaos sparks loose from your body. You take 1 point of damage for every point you fumbled by, and the GM picks one of the other elemental riders at random."
  },
  earth: {
    label: "Earth",
    effect: "The ground bucks beneath you. You take 1 point of damage for every point you fumbled by and are stunned."
  },
  air: {
    label: "Air",
    effect: "A sudden gale slams into you. You take 1 point of damage for every point you fumbled by and are thrown 2 metres backward."
  },
  fire: {
    label: "Fire",
    effect: "Your body bursts into flame. You take 1 point of damage for every point you fumbled by and are set on fire."
  },
  water: {
    label: "Water",
    effect: "Frost crackles and locks around your limbs. You take 1 point of damage for every point you fumbled by and are frozen."
  }
};

/** Which system status each elemental rider lands. Air (knockback 2m) and
 *  mixed (GM picks another) stay narrative — no clean status maps. */
const ELEMENTAL_RIDER = { earth: "stunned", fire: "burning", water: "freeze" };

/** Trigger an elemental fumble for over-exertion: land the rider status on
 *  `actor` and post the effect to chat. `element` picks the effect by the
 *  spell's school (earth/air/fire/water/mixed); when omitted or unknown it falls
 *  back to a random roll. `points` is how far the cast pushed past Vigor;
 *  `damage` is the HP already drained by the caller (5/point) — shown here. */
export async function triggerElementalFumble(actor, points = 0, damage = 0, element = null) {
  const keys = Object.keys(ELEMENTAL_FUMBLES);
  let el = (element && keys.includes(element)) ? element : null;
  let roll = null;
  if (!el) {
    roll = await new Roll(`1d${keys.length}`).evaluate();
    el = keys[(roll.total - 1) % keys.length];
  }
  const entry = ELEMENTAL_FUMBLES[el];

  const statusId = ELEMENTAL_RIDER[el];
  if (statusId && typeof actor?.toggleStatusEffect === "function") {
    try { await actor.toggleStatusEffect(statusId, { active: true }); }
    catch (e) { console.warn("witcher-ttrpg-death-march | elemental rider failed", e); }
  }

  const by = points > 0
    ? `<div style="font-size: 0.6875rem; color: #8c8579; letter-spacing: 0.12em; text-transform: uppercase;">over Vigor by <b style="color: #d6a050;">${points}</b></div>`
    : "";
  const dmgLine = damage > 0
    ? `<div style="font-weight: 700; color: #d66a6a; margin-bottom: 4px;">You take ${damage} damage from over-exertion.</div>`
    : "";
  const flavor = `
    <h2 style="margin: 0 0 4px;">Over-Exertion · Elemental Fumble · ${entry.label}</h2>
    ${by}`;
  const content = `
    <div style="border-left: 3px solid #b65a5a; padding: 6px 12px; margin: 4px 0;">
      ${dmgLine}
      <div style="font-style: italic;">${entry.effect}</div>
    </div>`;
  const speaker = actor ? ChatMessage.getSpeaker({ actor }) : ChatMessage.getSpeaker();
  await ChatMessage.create({
    speaker, flavor, content,
    ...(roll ? { rolls: [roll] } : {}),
    rollMode: game.settings.get("core", "rollMode"),
  });
  return el;
}

/** Show the picker, roll, and post to chat.  Speaker is the actor when one
 *  is supplied (so the chat message is attributed to the player's character);
 *  falls back to the default speaker otherwise. */
export async function openFumbleDialog(actor = null) {
  const DialogV2 = foundry.applications.api.DialogV2;
  const options = Object.entries(FUMBLES)
    .map(([k, v]) => `<option value="${k}">${v.label}</option>`)
    .join("");

  let category;
  try {
    category = await DialogV2.prompt({
      window: { title: t("WITCHER.Dialog.Fumble.Table", "Fumble Table") },
      modal: true,
      content: `
        <div style="padding: 8px 0;">
          <label style="display: flex; gap: 10px; align-items: center;">
            <span style="min-width: 60px;">Type</span>
            <select name="cat" autofocus style="flex: 1;">${options}</select>
          </label>
        </div>`,
      ok: { callback: (event, button) => button.form.elements.cat.value },
      rejectClose: true
    });
  } catch (e) {
    return;
  }
  if (!category) return;

  const roll = await new Roll("1d10").evaluate();
  const total = roll.total;
  const table = FUMBLES[category];
  const row = table.rows.find(([lo, hi]) => total >= lo && total <= hi);
  const result = row ? row[2] : "(out of range)";

  const flavor = `
    <h2 style="margin: 0 0 4px;">Fumble · ${table.label}</h2>
    <div style="font-size: 0.6875rem; color: #8c8579; letter-spacing: 0.12em; text-transform: uppercase;">
      1d10 = <b style="color: #d6a050;">${total}</b>
    </div>
  `;
  // Magic fumbles of 7+ call for an "elemental fumble effect"; offer a button
  // that lets the player pick which element they were channelling.
  const needsElemental = category === "magic" && total >= 7;
  const elementalBtn = needsElemental
    ? `
      <button type="button" data-action="wdm-elemental-fumble"
              style="margin-top: 8px; width: 100%; cursor: pointer;">
        <i class="fas fa-fire-flame-curved"></i> Resolve elemental fumble
      </button>`
    : "";

  /* Apply-damage buttons: parse [[XdY]] inline-roll formulas from the
   * fumble text and render one button per formula. Click rolls it and
   * applies the result to the FUMBLER's HP via the damage socket (raw
   * bypass — fumble damage doesn't go through SP/DR). Skipped when the
   * fumble narrates damage to a third party (ally / weapon reliability),
   * since those aren't HP hits on the fumbler. */
  const isSelfDamage = /yourself|you take|wound your|hit your head|fall prone|set on fire/i.test(result)
                    && !/ally|reliability|points of (reliability|durability)/i.test(result);
  const dmgFormulas = isSelfDamage
    ? [...result.matchAll(/\[\[([^\]]+)\]\]/g)].map(m => m[1].trim()).filter(Boolean)
    : [];
  const actorUuid = actor?.uuid ?? "";
  const isNonLethal = /non-lethal/i.test(result);
  const dmgButtons = (dmgFormulas.length && actorUuid)
    ? dmgFormulas.map(f =>
        `<button type="button" data-action="wdm-fumble-self-damage"
                 data-formula="${esc(f)}" data-uuid="${esc(actorUuid)}"
                 data-nonlethal="${isNonLethal ? "1" : "0"}"
                 style="margin-top:4px;width:100%;cursor:pointer;">
            <i class="fa-solid fa-burst"></i> Apply ${esc(f)} ${isNonLethal ? "non-lethal " : ""}damage to yourself
        </button>`
      ).join("")
    : "";

  const content = `
    <div style="border-left: 3px solid #b65a5a; padding: 6px 12px; margin: 4px 0;">
      <div style="font-style: italic;">${result}</div>
      ${dmgButtons}
      ${elementalBtn}
    </div>
  `;

  const speaker = actor ? ChatMessage.getSpeaker({ actor }) : ChatMessage.getSpeaker();
  await ChatMessage.create({
    speaker,
    flavor,
    content,
    rolls: [roll],
    rollMode: game.settings.get("core", "rollMode"),
    flags: { "witcher-ttrpg-death-march": { category: "combat" } }
  });
}

function esc(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("'", "&#39;")
    .replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Prompt for the channelled element, then post its effect to chat. */
async function resolveElementalFumble(speaker) {
  const DialogV2 = foundry.applications.api.DialogV2;
  const options = Object.entries(ELEMENTAL_FUMBLES)
    .map(([k, v]) => `<option value="${k}">${v.label}</option>`)
    .join("");

  let element;
  try {
    element = await DialogV2.prompt({
      window: { title: t("WITCHER.Dialog.Fumble.Elemental", "Elemental Fumble") },
      modal: true,
      content: `
        <div style="padding: 8px 0;">
          <label style="display: flex; gap: 10px; align-items: center;">
            <span style="min-width: 60px;">Element</span>
            <select name="el" autofocus style="flex: 1;">${options}</select>
          </label>
        </div>`,
      ok: { callback: (event, button) => button.form.elements.el.value },
      rejectClose: true
    });
  } catch (e) {
    return;
  }
  if (!element) return;

  const entry = ELEMENTAL_FUMBLES[element];
  if (!entry) return;

  const flavor = `
    <h2 style="margin: 0 0 4px;">Elemental Fumble · ${entry.label}</h2>
  `;
  const content = `
    <div style="border-left: 3px solid #b65a5a; padding: 6px 12px; margin: 4px 0;">
      <div style="font-style: italic;">${entry.effect}</div>
    </div>
  `;

  await ChatMessage.create({
    speaker: speaker ?? ChatMessage.getSpeaker(),
    flavor,
    content,
    rollMode: game.settings.get("core", "rollMode"),
  });
}

/** Roll a fumble's self-damage formula and apply it to the fumbler via
 *  the GM-proxied damage socket. Bypasses armor (fumble damage is a
 *  flat HP hit per RAW). */
async function applyFumbleSelfDamage(btn) {
  const formula = btn?.dataset?.formula;
  const uuid    = btn?.dataset?.uuid;
  if (!formula || !uuid) return;
  btn.disabled = true;
  try {
    const roll = await new Roll(formula).evaluate();
    await roll.toMessage({
      flavor: `<em>Fumble self-damage roll</em>`,
      flags: { "witcher-ttrpg-death-march": { category: "combat" } }
    });
    const { emitApplyDamage } = await import("../../setup/socketHook.mjs");
    await emitApplyDamage({
      targetUuid:    uuid,
      weaponDamage:  roll.total,
      damageTypes:   [],
      locationKey:   "head",         // fumble narrates "head" or "self" — use head as default
      locationLabel: "Head",
      qualities:     [],
      qualityValues: {},
      throughArmor:  true            // RAW fumble damage isn't soaked
    });
  } catch (err) {
    console.error("witcher-ttrpg-death-march | fumble self-damage failed", err);
    ui.notifications?.error(t("WITCHER.Notify.Fumble.ApplyFailed", "Fumble damage apply failed — see console."));
    btn.disabled = false;
  }
}

/** Wire the "Resolve elemental fumble" + "Apply X damage to yourself"
 *  buttons on fumble chat cards. */
export function installFumbleChatHandler() {
  Hooks.on("renderChatMessageHTML", (msg, el) => {
    const elem = el.querySelector?.('button[data-action="wdm-elemental-fumble"]');
    if (elem && !elem.dataset.wired) {
      elem.dataset.wired = "1";
      elem.addEventListener("click", () => resolveElementalFumble(msg.speaker));
    }
    for (const dmg of el.querySelectorAll?.('button[data-action="wdm-fumble-self-damage"]') ?? []) {
      if (dmg.dataset.wired) continue;
      dmg.dataset.wired = "1";
      dmg.addEventListener("click", () => applyFumbleSelfDamage(dmg));
    }
  });
}
