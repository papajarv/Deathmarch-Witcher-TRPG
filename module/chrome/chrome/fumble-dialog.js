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
const ELEMENTAL_FUMBLE_FALLBACKS = {
  mixed: { label: "Mixed / Chaos", effect: "Raw chaos sparks loose from your body. You take 1 point of damage for every point you fumbled by, and the GM picks one of the other elemental riders at random." },
  earth: { label: "Earth",         effect: "The ground bucks beneath you. You take 1 point of damage for every point you fumbled by and are stunned." },
  air:   { label: "Air",           effect: "A sudden gale slams into you. You take 1 point of damage for every point you fumbled by and are thrown 2 metres backward." },
  fire:  { label: "Fire",          effect: "Your body bursts into flame. You take 1 point of damage for every point you fumbled by and are set on fire." },
  water: { label: "Water",         effect: "Frost crackles and locks around your limbs. You take 1 point of damage for every point you fumbled by and are frozen." },
};
const _EF_KEY = { mixed: "MixedChaos", earth: "Earth", air: "Air", fire: "Fire", water: "Water" };
const ELEMENTAL_FUMBLES = Object.fromEntries(Object.entries(ELEMENTAL_FUMBLE_FALLBACKS).map(([id, fb]) => [id, Object.freeze({
  get label()  { return t(`WITCHER.Chrome.FumbleDialog.Dialog.Button.${_EF_KEY[id]}`, fb.label); },
  get effect() { return t(`WITCHER.Chrome.FumbleDialog.Effect.${_EF_KEY[id]}`,        fb.effect); },
})]));

/** Trigger an elemental fumble for over-exertion. Over-exertion itself stays
 *  wired — the caller (castSpellMixin) still drains the HP cost — but the
 *  elemental RESULT is narrative-only: the effect text names the rider
 *  (stunned / set on fire / frozen / knockback) for the player or GM to apply,
 *  nothing is auto-applied here. `element` picks the effect by the spell's
 *  school (earth/air/fire/water/mixed); when omitted or unknown it falls back
 *  to a random roll. `points` is how far the cast pushed past Vigor; `damage`
 *  is the HP already drained by the caller (5/point) — shown here. */
export async function triggerElementalFumble(actor, points = 0, damage = 0, element = null) {
  const keys = Object.keys(ELEMENTAL_FUMBLES);
  let el = (element && keys.includes(element)) ? element : null;
  let roll = null;
  if (!el) {
    roll = await new Roll(`1d${keys.length}`).evaluate();
    el = keys[(roll.total - 1) % keys.length];
  }
  const entry = ELEMENTAL_FUMBLES[el];

  const by = points > 0
    ? `<div style="font-size: 0.6875rem; color: #8c8579; letter-spacing: 0.12em; text-transform: uppercase;">${tFormat("WITCHER.Chrome.FumbleDialog.Text.OverVigorBy", { points }, `over Vigor by <b style="color: #d6a050;">${points}</b>`)}</div>`
    : "";
  const dmgLine = damage > 0
    ? `<div style="font-weight: 700; color: #d66a6a; margin-bottom: 4px;">${tFormat("WITCHER.Chrome.FumbleDialog.Text.OverExertionDamage", { damage }, `You take ${damage} damage from over-exertion.`)}</div>`
    : "";
  const flavor = `
    <h2 style="margin: 0 0 4px;">${tFormat("WITCHER.Chrome.FumbleDialog.Text.Header", { label: entry.label }, `Over-Exertion · Elemental Fumble · ${entry.label}`)}</h2>
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
  const options = Object.entries(FUMBLES())
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
            <span style="min-width: 60px;">${t("WITCHER.Chrome.FumbleDialog.Label.Type", "Type")}</span>
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
  const table = FUMBLES()[category];
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
        <i class="fas fa-fire-flame-curved"></i> ${t("WITCHER.Chrome.FumbleDialog.Text.ResolveElemental", "Resolve elemental fumble")}
      </button>`
    : "";

  /* Fumble effects are NARRATIVE-only. The outcome text keeps its inline
   * [[XdY]] rolls so you can still see the numbers, but nothing is applied to
   * HP — the player/GM adjudicates the consequence. (No auto-apply buttons.) */
  const content = `
    <div style="border-left: 3px solid #b65a5a; padding: 6px 12px; margin: 4px 0;">
      <div style="font-style: italic;">${result}</div>
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
            <span style="min-width: 60px;">${t("WITCHER.Chrome.FumbleDialog.Label.Element", "Element")}</span>
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

/** Wire the "Resolve elemental fumble" button on fumble chat cards — it opens
 *  the element picker and posts that element's narrative text. Fumble effects
 *  are narrative-only, so there are no auto-apply buttons to wire. */
export function installFumbleChatHandler() {
  Hooks.on("renderChatMessageHTML", (msg, el) => {
    const elem = el.querySelector?.('button[data-action="wdm-elemental-fumble"]');
    if (elem && !elem.dataset.wired) {
      elem.dataset.wired = "1";
      elem.addEventListener("click", () => resolveElementalFumble(msg.speaker));
    }
  });
}
