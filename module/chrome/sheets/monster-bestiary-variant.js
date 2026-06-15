/**
 * Monster sheet · "Bestiary variant" pill.
 *
 * Adds a small GM-only toggle to the monster sheet HUD's tag row.  When ON,
 * this specific actor is treated as its own bestiary entry instead of being
 * grouped under its compendium source.  Used for narrative variants like a
 * Bloodmoon Werewolf or a Cursed Drowner — they get their own card, their
 * own research/encounter state.
 *
 * Flag schema:
 *
 *   actor.flags["witcher-ttrpg-death-march"].bestiaryVariant = boolean
 *
 * See docs/superpowers/specs/2026-05-23-bestiary-design.md for the broader
 * UUID-resolution rules this flag participates in.
 */

import {
  isBestiaryVariant,
  setBestiaryVariant
} from "../lib/bestiary.js";

Hooks.on("renderWitcherMonsterSheet", (app, element /*, context */) => {
  const actor = app.actor ?? app.document;
  if (!actor || actor.type !== "monster") return;

  /* GM-only — players don't need to see (or be confused by) this. */
  if (!game.user?.isGM) return;

  const root = element instanceof HTMLElement ? element : element[0];
  if (!root) return;
  if (root.querySelector(".wou-bestiary-variant-pill")) return;

  const tagRow = root.querySelector(".monster-hud .hud-tags");
  if (!tagRow) return;
  /* Sit immediately before the action-buttons cluster so the pill anchors
   * at the right end of the tag row.  `.configure-actor` lives inside
   * `.hud-tag-actions`, so anchor on the actions wrapper itself —
   * anchoring on the nested cog throws NotFoundError from insertBefore. */
  const anchor = tagRow.querySelector(":scope > .hud-tag-actions")
              ?? tagRow.querySelector(":scope > .configure-actor")
              ?? null;

  const on = isBestiaryVariant(actor);
  const pill = document.createElement("label");
  pill.className = `tag wou-bestiary-variant-pill${on ? " is-on" : ""}`;
  pill.dataset.tooltip = on
    ? "This actor has its own bestiary entry, separate from its compendium source."
    : "Default: this actor groups with its compendium source. Click to split into its own bestiary entry.";
  pill.innerHTML = `
    <input type="checkbox" ${on ? "checked" : ""} />
    <i class="fa-solid fa-dragon"></i>
    <span>Bestiary variant</span>
  `;

  if (anchor) tagRow.insertBefore(pill, anchor);
  else tagRow.appendChild(pill);

  const checkbox = pill.querySelector("input[type=checkbox]");
  checkbox?.addEventListener("change", async () => {
    await setBestiaryVariant(actor, checkbox.checked);
    pill.classList.toggle("is-on", checkbox.checked);
  });
});
