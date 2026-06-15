/**
 * Actor sidebar context menu — adds "Apply Status" entry that pops a small
 * picker.  Selecting an entry applies the corresponding CONFIG.statusEffect
 * to the actor via `Actor#toggleStatusEffect`.
 *
 * The same context-menu API also fires for the Combat Tracker (the Document
 * hook fires from every directory that lists the Document type), so this
 * hook is wired once and the entry shows up everywhere Foundry surfaces
 * actor right-click menus.
 */

import { MODULE_ID } from "../setup/settings.js";
import { clauseFor } from "../../mechanics/statusEngine.mjs";

const ICON = "fa-solid fa-sparkles";

/* DoT statuses (bleed, burning, acid, poison …) stack per instance — each
 * application is its own effect and ticks separately. So the picker ADDS a new
 * instance rather than toggling the shared status off, which lets you pile a
 * fresh combat bleed on top of wound-sourced bleeds. */
const isStackable = (id) => !!clauseFor(id)?.dot;
const statusCount = (actor, id) =>
  actor.effects?.contents?.filter(e => e.statuses?.has?.(id)).length ?? 0;

export function registerActorContextMenu() {
  /* In Foundry V13, document directories fire `get<Document>ContextOptions`
   * with the array of entries to mutate.  For the actor directory the hook
   * is getActorContextOptions; the entry's callback receives the `li`
   * element representing the document row, so we fish the actor out of its
   * dataset. */
  Hooks.on("getActorContextOptions", (app, entries) => addApplyStatus(entries));
  /* Combat tracker right-click on a combatant. The CombatTracker derives its
   * context hook from `get{}ContextOptions` → the CLASS name, so the real hook
   * is getCombatTrackerContextOptions (the @fires JSDoc's getCombatantContext-
   * Options is misleading). Register both to be safe — addApplyStatus dedupes.
   * Rows expose data-combatant-id; resolve via game.combat. */
  const combatResolver = {
    resolveActor: (li) => {
      const cid = li?.dataset?.combatantId ?? li?.closest?.("[data-combatant-id]")?.dataset?.combatantId;
      const combatant = cid ? game.combat?.combatants?.get(cid) : null;
      return combatant?.actor ?? null;
    }
  };
  Hooks.on("getCombatTrackerContextOptions", (app, entries) => addApplyStatus(entries, combatResolver));
  Hooks.on("getCombatantContextOptions",     (app, entries) => addApplyStatus(entries, combatResolver));
}

function addApplyStatus(entries, opts = {}) {
  // Both combat-tracker hook names may fire — don't add the entry twice.
  if (entries.some(e => e?.name === "Apply Status")) return;
  const resolveActor = opts.resolveActor ?? defaultResolveActor;
  entries.push({
    name: "Apply Status",
    icon: `<i class="${ICON}"></i>`,
    condition: (li) => {
      if (!game.user?.isGM) return false;
      const actor = resolveActor(li);
      return !!actor;
    },
    callback: (li) => {
      const actor = resolveActor(li);
      if (!actor) return;
      void openStatusPicker(actor);
    }
  });
}

function defaultResolveActor(li) {
  /* V13 directory rows expose data-document-id (sometimes data-entry-id on
   * older builds).  Try both. */
  const id = li?.dataset?.documentId ?? li?.dataset?.entryId;
  return id ? game.actors?.get(id) : null;
}

/* =========================================================================
   PICKER
   ========================================================================= */

/**
 * Open a DialogV2 with a grid of status-effect icons.  Click an icon to
 * apply it to the actor.  Closes immediately after applying.
 */
async function openStatusPicker(actor) {
  const statuses = (globalThis.CONFIG?.statusEffects ?? [])
    .filter(se => se?.id && se?.img)
    .slice();
  if (!statuses.length) {
    ui.notifications?.warn(`${MODULE_ID} | no status effects configured.`);
    return;
  }

  const content = `
    <div class="wou-apply-status-grid">
      ${statuses.map(se => {
        const label = se.name ? game.i18n.localize(se.name) : se.id;
        const stack = isStackable(se.id);
        const count = statusCount(actor, se.id);
        const isActive = count > 0;
        const title = stack
          ? `${label} — left-click: add a stack · right-click: remove one (non-wound)`
          : label;
        return `<button type="button"
                        class="wou-apply-status-cell${isActive ? " is-active" : ""}"
                        data-status-id="${escapeAttr(se.id)}"
                        data-stackable="${stack}"
                        data-label="${escapeAttr(label)}"
                        title="${escapeAttr(title)}">
                  <img src="${escapeAttr(se.img)}" alt="${escapeAttr(label)}" />
                  <span>${escapeText(label)}${stack && count > 0 ? ` ×${count}` : ""}</span>
                </button>`;
      }).join("")}
    </div>
  `;

  const DialogV2 = foundry?.applications?.api?.DialogV2;
  if (!DialogV2) {
    ui.notifications?.error(`${MODULE_ID} | DialogV2 unavailable on this Foundry build.`);
    return;
  }

  const dialog = await DialogV2.wait({
    window: { title: `Apply Status — ${actor.name}`, icon: ICON },
    content,
    buttons: [{ action: "close", label: "Done", default: true }],
    rejectClose: false,
    classes: ["wou-apply-status-dialog"],
    render: (_event, dlg) => {
      const root = dlg?.element ?? dlg;
      const refresh = (btn, id, stack) => {
        const count = statusCount(actor, id);
        btn.classList.toggle("is-active", count > 0);
        const span = btn.querySelector("span");
        if (span) span.textContent = `${btn.dataset.label}${stack && count > 0 ? ` ×${count}` : ""}`;
      };
      root?.querySelectorAll?.(".wou-apply-status-cell").forEach(btn => {
        const id = btn.dataset.statusId;
        const stack = btn.dataset.stackable === "true";
        if (!id) return;
        btn.addEventListener("click", async (ev) => {
          ev.preventDefault();
          try {
            if (stack) {
              /* DoT statuses stack: add a fresh (non-wound) instance on top of
               * any existing — including wound-sourced bleeds. */
              const def = (CONFIG.statusEffects ?? []).find(s => s.id === id) ?? {};
              await actor.createEmbeddedDocuments("ActiveEffect", [{
                name:     def.name ? game.i18n.localize(def.name) : id,
                img:      def.img ?? "icons/svg/aura.svg",
                statuses: [id]
              }]);
            } else {
              /* Non-stacking status — binary toggle on the shared Set. */
              const active = actor.statuses?.has?.(id) ?? false;
              await actor.toggleStatusEffect(id, { active: !active });
            }
          } catch (err) {
            console.warn(`${MODULE_ID} | apply status ${id} failed`, err);
            ui.notifications?.error(`Failed to apply status: ${id}`);
            return;
          }
          refresh(btn, id, stack);
        });
        if (stack) btn.addEventListener("contextmenu", async (ev) => {
          ev.preventDefault();
          /* Remove one NON-wound instance — wound-sourced instances are left
           * alone (they clear only when the wound is treated). */
          const nonWound = (actor.effects?.contents ?? [])
            .filter(e => e.statuses?.has?.(id) && !e.flags?.[MODULE_ID]?.woundStatus);
          if (nonWound.length) {
            try { await actor.deleteEmbeddedDocuments("ActiveEffect", [nonWound[nonWound.length - 1].id]); }
            catch (err) { console.warn(`${MODULE_ID} | remove status ${id} failed`, err); }
          } else {
            ui.notifications?.info(`No removable ${id} — wound-sourced instances clear when the wound is treated.`);
          }
          refresh(btn, id, stack);
        });
      });
    }
  }).catch(() => null);
  return dialog;
}

/* =========================================================================
   UTILS
   ========================================================================= */

function escapeText(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
function escapeAttr(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
