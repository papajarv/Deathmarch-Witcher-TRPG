/**
 * Fumble lookup dialog.
 *
 * Hooked to the dock's combat-mode "Fumble" sign.  Prompts the user to
 * pick a fumble category, rolls 1d10, looks up the matching row from the
 * RAW Witcher TRPG fumble tables, and posts the result to chat as a real
 * roll message (so DSN dice animate and the d10 shows up as a normal
 * roll line).
 *
 * Tables match the strings in TheWitcherTRPG/lang/en.json under
 * `WITCHER.fumbleResults.*`.  Two categories share the same underlying
 * table per RAW + the system's own `fumble.js` dispatch logic:
 *   - Brawling / Unarmed Attack
 *   - Unarmed Defense / Dodge / Athletics
 * Both route through the system's `unarmed.*` table (different fiction,
 * same mechanical result).
 */

const FUMBLES = {
  meleeAttack: {
    label: "Melee Attack (Armed)",
    rows: [
      [1,  5,         "Nothing happens — your strike misses cleanly."],
      [6,  6,         "Your weapon glances off and you are staggered."],
      [7,  7,         "Your weapon lodges in a nearby object and it takes 1 round to free."],
      [8,  8,         "You damage your weapon severely. Your weapon takes [[1d10]] points of reliability damage."],
      [9,  9,         "You manage to wound yourself. Roll for location."],
      [10, Infinity,  "You wound a nearby ally. Roll location on a random ally within range."]
    ]
  },
  armedDefense: {
    label: "Melee Defense (Armed)",
    rows: [
      [1,  5,         "Nothing happens — your defense holds."],
      [6,  6,         "Your weapon takes [[1d6]] extra points of reliability damage."],
      [7,  7,         "Your weapon is knocked from your hand and flies [[1d6]] meters away in a random direction (see Scatter table)."],
      [8,  8,         "You are knocked to the ground. You are now prone and must make a Stun save."],
      [9,  9,         "Your weapon takes [[2d6]] extra points of reliability damage."],
      [10, Infinity,  "Your weapon ricochets back and hits you. Roll for location."]
    ]
  },
  rangedAttack: {
    label: "Ranged Attack",
    rows: [
      [1,  5,         "Nothing happens — your shot just misses."],
      [6,  7,         "The ammunition you fired, or weapon you threw, hits something hard, breaking."],
      [8,  9,         "Your bowstring comes partially undone, your crossbow jams, or you drop your thrown weapon. It takes 1 round to undo this."],
      [10, Infinity,  "You strike one of your allies with a ricochet. Roll location on a random ally within range."]
    ]
  },
  magic: {
    label: "Magic / Spellcasting",
    rows: [
      [1,  6,         "Magic sparks and crackles and you take 1 point of damage for every point you fumbled by, but the spell still goes off."],
      [7,  9,         "The magic that is already partially through you ignites inside you. Not only does the spell fail but you suffer an elemental fumble effect."],
      [10, Infinity,  "Your magic explodes with a catastrophic effect. Not only do you suffer an elemental fumble effect, but any focusing item you are carrying explodes as if it were a bomb ([[1d10]] damage, 2m radius)."]
    ]
  },
  unarmedAttack: {
    label: "Brawling / Unarmed Attack",
    rows: [
      [1,  5,         "Nothing happens — your blow goes wide."],
      [6,  6,         "You are knocked off balance and are staggered."],
      [7,  7,         "You trip on something and fall prone."],
      [8,  8,         "You trip and fall prone. You must make a Stun save."],
      [9,  9,         "You trip and hit your head. You are knocked prone, take [[1d6]] non-lethal damage to the head, and must make a Stun save."],
      [10, Infinity,  "You fail horribly and not only fall prone but also take [[1d6]] lethal damage to the head and must make a Stun save."]
    ]
  },
  unarmedDefense: {
    /* Same underlying table as unarmedAttack — RAW.  Kept as a separate
     * category for picker clarity since the in-fiction story is different. */
    label: "Unarmed Defense / Dodge / Athletics",
    rows: [
      [1,  5,         "Nothing happens — you recover."],
      [6,  6,         "You are knocked off balance and are staggered."],
      [7,  7,         "You trip on something and fall prone."],
      [8,  8,         "You trip and fall prone. You must make a Stun save."],
      [9,  9,         "You trip and hit your head. You are knocked prone, take [[1d6]] non-lethal damage to the head, and must make a Stun save."],
      [10, Infinity,  "You fail horribly and not only fall prone but also take [[1d6]] lethal damage to the head and must make a Stun save."]
    ]
  }
};

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
    ? `<div style="font-size: 11px; color: #8c8579; letter-spacing: 0.12em; text-transform: uppercase;">over Vigor by <b style="color: #d6a050;">${points}</b></div>`
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
      window: { title: "Fumble Table" },
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
    <div style="font-size: 11px; color: #8c8579; letter-spacing: 0.12em; text-transform: uppercase;">
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
      window: { title: "Elemental Fumble" },
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

/** Wire the "Resolve elemental fumble" button on magic fumble chat cards. */
export function installFumbleChatHandler() {
  Hooks.on("renderChatMessageHTML", (msg, el) => {
    const btn = el.querySelector?.('button[data-action="wdm-elemental-fumble"]');
    if (btn && !btn.dataset.wired) {
      btn.dataset.wired = "1";
      btn.addEventListener("click", () => resolveElementalFumble(msg.speaker));
    }
  });
}
