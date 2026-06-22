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
  Hooks.on("getCombatTrackerContextOptions", (app, entries) => addTargetActor(entries, combatResolver));
  Hooks.on("getCombatantContextOptions",     (app, entries) => addTargetActor(entries, combatResolver));
}

/* Target / Untarget toggle — works for both placed tokens AND tokenless
 * play. Routes:
 *   1. Active token on canvas → use Foundry's standard `token.setTarget`
 *      so the canvas reticle + downstream `game.user.targets` work as
 *      they would for any normal targeting (and the rest of the system
 *      sees a real token target).
 *   2. No active token → fall back to a per-user actor-target flag that
 *      the attack flow reads via `getActorTarget` when game.user.targets
 *      is empty. This is the theater-of-mind path.
 */
const ACTOR_TARGET_FLAG = "actorTargetUuid";
function addTargetActor(entries, opts = {}) {
  if (entries.some(e => e?.name === "Target / Untarget")) return;
  const resolveActor = opts.resolveActor ?? defaultResolveActor;
  entries.push({
    name: "Target / Untarget",
    icon: '<i class="fa-solid fa-crosshairs"></i>',
    condition: (li) => !!resolveActor(li),
    callback: async (li) => {
      const actor = resolveActor(li);
      if (!actor) return;

      /* Prefer a real token target when one is on the active scene —
       * this gives the canvas reticle + standard target semantics. */
      const liveTokens = (typeof actor.getActiveTokens === "function")
        ? actor.getActiveTokens()
        : [];
      const token = liveTokens[0] ?? null;
      if (token) {
        const wasTargeted = !!game.user?.targets?.has?.(token);
        try {
          token.setTarget(!wasTargeted, { user: game.user, releaseOthers: !wasTargeted, groupSelection: false });
          // Also clear any tokenless actor-target flag so the two systems
          // don't get out of sync.
          if (game.user?.getFlag?.(MODULE_ID, ACTOR_TARGET_FLAG)) {
            await game.user.unsetFlag(MODULE_ID, ACTOR_TARGET_FLAG);
          }
          ui.notifications?.info(`${wasTargeted ? "Released" : "Targeting"} ${actor.name}.`);
        } catch (err) {
          console.warn("witcher-ttrpg-death-march | target via combat-tracker failed", err);
        }
        return;
      }

      /* No token on canvas — toggle the per-user actor-target flag.
       * The attack flow's getActorTarget() will resolve to this actor
       * when game.user.targets is empty. */
      const cur = game.user?.getFlag?.(MODULE_ID, ACTOR_TARGET_FLAG);
      if (cur === actor.uuid) {
        await game.user.unsetFlag(MODULE_ID, ACTOR_TARGET_FLAG);
        ui.notifications?.info(`No longer targeting ${actor.name}.`);
      } else {
        await game.user.setFlag(MODULE_ID, ACTOR_TARGET_FLAG, actor.uuid);
        ui.notifications?.info(`Targeting ${actor.name} (tokenless — no canvas token found).`);
      }
    }
  });
}

/** Public resolver: the attack flow uses this to find the user's "actor
 *  target" when no token target is active. Returns the targeted Actor or
 *  null. Cheap — no document load required when no flag is set. */
export async function getActorTarget() {
  const uuid = game.user?.getFlag?.(MODULE_ID, ACTOR_TARGET_FLAG);
  if (!uuid) return null;
  try { return await fromUuid(uuid); }
  catch (_) { return null; }
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
