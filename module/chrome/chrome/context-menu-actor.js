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
import { setActorOverride } from "../lib/actor.js";

import { t, tFormat } from "../lib/i18n.js";
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
  /* GM-only "Accepts Gifts" toggle: flips flags.<sysId>.acceptsGifts on
     the actor. When on, the actor appears in every player's Gift Item
     dialog's recipient list even when they lack LIMITED/OBSERVER
     permission on it — the GM's socket handler runs the write with full
     perms, so no permission relaxation is needed elsewhere. Only added
     to the Actor Directory (not the combat tracker) since it's an
     out-of-play authoring toggle. */
  Hooks.on("getActorContextOptions", (app, entries) => addAcceptsGifts(entries));
  /* Combat tracker right-click on a combatant. The CombatTracker derives its
   * context hook from `get{}ContextOptions` → the CLASS name, so the real hook
   * is getCombatTrackerContextOptions (the @fires JSDoc's getCombatantContext-
   * Options is misleading). Register both to be safe — addApplyStatus dedupes.
   * Rows expose data-combatant-id; resolve via game.combat. */
  const combatResolver = {
    resolveActor: (li) => {
      const cid = li?.dataset?.combatantId ?? li?.closest?.("[data-combatant-id]")?.dataset?.combatantId;
      const combatant = cid ? game.combat?.combatants?.get(cid) : null;
      if (!combatant) return null;
      /* Resolve through the TOKEN first. An unlinked token whose base actor was
       * deleted ("orphaned") still carries its full stats on its own synthetic /
       * delta actor — but `combatant.actor` can come back null on that path, which
       * hid the "Control" (and other) entries entirely. Prefer the token's own
       * actor, then the placeable's, before the directory lookup that no longer
       * exists. */
      return combatant.token?.actor
          ?? combatant.token?.object?.actor
          ?? combatant.actor
          ?? (combatant.actorId ? game.actors?.get?.(combatant.actorId) : null)
          ?? null;
    }
  };
  Hooks.on("getCombatTrackerContextOptions", (app, entries) => addApplyStatus(entries, combatResolver));
  Hooks.on("getCombatantContextOptions",     (app, entries) => addApplyStatus(entries, combatResolver));
  Hooks.on("getCombatTrackerContextOptions", (app, entries) => addTargetActor(entries, combatResolver));
  Hooks.on("getCombatantContextOptions",     (app, entries) => addTargetActor(entries, combatResolver));
  /* GM-only "Control" → View As this actor. Binds every chrome surface (dock,
   * hotbar, inventory/character/journal/bestiary tabs) to the picked actor via
   * the shared session override. Available from the Actor Directory AND the
   * initiative/combat tracker (so a GM can hop to whoever's turn it is). */
  Hooks.on("getActorContextOptions",         (app, entries) => addControl(entries));
  Hooks.on("getCombatTrackerContextOptions", (app, entries) => addControl(entries, combatResolver));
  Hooks.on("getCombatantContextOptions",     (app, entries) => addControl(entries, combatResolver));
}

/** GM-only "Control" (View As) entry. Points the shared viewer override at the
 *  actor so all chrome reports it as the assigned actor. Passing the Actor
 *  instance lets setActorOverride capture a synthetic token actor (unlinked
 *  token in the tracker) so control lands on that token's own delta. */
function addControl(entries, opts = {}) {
  const label = t("WITCHER.Chrome.ContextMenuActor.Text.Control", "Control");
  if (entries.some(e => e?.name === label)) return;
  const resolveActor = opts.resolveActor ?? defaultResolveActor;
  entries.push({
    name: label,
    icon: '<i class="fa-solid fa-eye"></i>',
    condition: (li) => !!game.user?.isGM && !!resolveActor(li),
    callback: (li) => {
      const actor = resolveActor(li);
      if (!actor) return;
      setActorOverride(actor);
      ui.notifications?.info(tFormat("WITCHER.Chrome.ContextMenuActor.Notify.Controlling", { name: actor.name }, `Now viewing as ${actor.name}.`));
    }
  });
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
 *
 * Multi-target: the tokenless path holds a LIST of UUIDs so a user can
 * stack several actors the same way `game.user.targets` stacks tokens
 * on the canvas. Legacy single-value flag (`actorTargetUuid`) is
 * still read as a fallback for saves authored before the list existed;
 * writes always go to the new `actorTargetUuids` list.
 */
const ACTOR_TARGET_FLAG      = "actorTargetUuid";    // legacy, string
const ACTOR_TARGET_LIST_FLAG = "actorTargetUuids";   // current, string[]

/** Read the CURRENT tokenless target list, merging the legacy single
 *  flag when present. Result is a deduped array — safe to iterate. */
export function readActorTargetUuids() {
  const list = game.user?.getFlag?.(MODULE_ID, ACTOR_TARGET_LIST_FLAG);
  const arr  = Array.isArray(list) ? list.filter(Boolean).map(String) : [];
  const legacy = game.user?.getFlag?.(MODULE_ID, ACTOR_TARGET_FLAG);
  if (legacy && !arr.includes(String(legacy))) arr.push(String(legacy));
  return arr;
}

/** Write the tokenless target list. Empty array unsets the flag rather
 *  than storing []. Also clears the legacy single-value flag so the two
 *  can't drift apart. */
async function writeActorTargetUuids(uuids) {
  const clean = Array.from(new Set((uuids ?? []).filter(Boolean).map(String)));
  if (clean.length) {
    await game.user.setFlag(MODULE_ID, ACTOR_TARGET_LIST_FLAG, clean);
  } else if (game.user?.getFlag?.(MODULE_ID, ACTOR_TARGET_LIST_FLAG)) {
    await game.user.unsetFlag(MODULE_ID, ACTOR_TARGET_LIST_FLAG);
  }
  if (game.user?.getFlag?.(MODULE_ID, ACTOR_TARGET_FLAG)) {
    await game.user.unsetFlag(MODULE_ID, ACTOR_TARGET_FLAG);
  }
}

/** Toggle a single actor's UUID in the tokenless target list. Returns
 *  the new state (true = now targeted, false = removed). */
export async function toggleActorTargetUuid(actorUuid) {
  const list = readActorTargetUuids();
  const idx  = list.indexOf(String(actorUuid));
  if (idx >= 0) list.splice(idx, 1);
  else          list.push(String(actorUuid));
  await writeActorTargetUuids(list);
  return idx < 0;
}
function addTargetActor(entries, opts = {}) {
  const targetUntargetLabel = t("WITCHER.Chrome.ContextMenuActor.Text.TargetUntarget", "Target / Untarget");
  if (entries.some(e => e?.name === targetUntargetLabel)) return;
  const resolveActor = opts.resolveActor ?? defaultResolveActor;
  entries.push({
    name: targetUntargetLabel,
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
          /* releaseOthers:false so right-click also stacks (matches
           * middle-click + canvas Ctrl-click). The user can right-click
           * a second row to add it to the target set without dropping
           * the first. */
          token.setTarget(!wasTargeted, { user: game.user, releaseOthers: false, groupSelection: false });
        } catch (err) {
          console.warn("witcher-ttrpg-death-march | target via combat-tracker failed", err);
        }
        return;
      }

      /* No token on canvas — toggle the actor's UUID in the tokenless
       * target LIST. The attack flow's getActorTarget()/getActorTargets()
       * resolve entries from this list when game.user.targets is empty. */
      await toggleActorTargetUuid(actor.uuid);
    }
  });
}

/** Public resolver: the attack flow uses this to find the user's "actor
 *  target" when no token target is active. Returns the FIRST targeted
 *  Actor from the list (backwards-compat for single-target call sites),
 *  or null when the list is empty. Cheap — no document load when no
 *  flag is set. */
export async function getActorTarget() {
  const uuids = readActorTargetUuids();
  if (!uuids.length) return null;
  try { return await fromUuid(uuids[0]); }
  catch (_) { return null; }
}

/** Multi-target variant: returns EVERY actor in the tokenless target
 *  list. Empty array when nothing is targeted. Call sites that support
 *  striking multiple opponents (AoE spells, sweeping brawl actions,
 *  future multi-target riders) should use this instead of getActorTarget. */
export async function getActorTargets() {
  const uuids = readActorTargetUuids();
  if (!uuids.length) return [];
  const out = [];
  for (const uuid of uuids) {
    try {
      const a = await fromUuid(uuid);
      if (a) out.push(a);
    } catch (_) { /* stale uuid — skip */ }
  }
  return out;
}

function addApplyStatus(entries, opts = {}) {
  const applyStatusLabel = t("WITCHER.Chrome.ContextMenuActor.Text.ApplyStatus", "Apply Status");
  // Both combat-tracker hook names may fire — don't add the entry twice.
  if (entries.some(e => e?.name === applyStatusLabel)) return;
  const resolveActor = opts.resolveActor ?? defaultResolveActor;
  entries.push({
    name: applyStatusLabel,
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

/** Actor Directory entry: toggle flags.<sysId>.acceptsGifts on the
 *  actor. When on, the actor appears in every player's Gift Item
 *  recipient list regardless of permission.
 *
 *  Split into TWO mutually-exclusive entries so the LABEL reflects the
 *  current state ("Accepts Gifts" when off — click to turn on; "Reject
 *  Gifts" when on — click to turn off). Foundry context menus set the
 *  `name` at registration time, so a dynamic label needs two entries
 *  with condition() picking which one shows.
 *
 *  Access gate: GM always sees it; players see it on actors they OWN
 *  (their own character). Non-owner players don't get the toggle —
 *  they can still gift TO the actor if the GM (or the actor's owner)
 *  has already flipped it on. */
function _canToggleAcceptsGifts(actor) {
  if (!actor) return false;
  if (game.user?.isGM) return true;
  try { return !!actor.isOwner; } catch { return false; }
}
async function _flipAcceptsGifts(actor, turnOn) {
  try {
    if (turnOn) await actor.setFlag(MODULE_ID, "acceptsGifts", true);
    else        await actor.unsetFlag(MODULE_ID, "acceptsGifts");
    ui.notifications?.info(
      turnOn
        ? tFormat("WITCHER.Chrome.ContextMenuActor.Notify.GiftsAcceptedOn", { name: actor.name }, `${actor.name}: gifts now accepted from any player.`)
        : tFormat("WITCHER.Chrome.ContextMenuActor.Notify.GiftsAcceptedOff", { name: actor.name }, `${actor.name}: gifts no longer accepted from any player.`)
    );
  } catch (err) {
    console.warn(`${MODULE_ID} | acceptsGifts toggle failed`, err);
  }
}
function addAcceptsGifts(entries) {
  const acceptsGiftsLabel = t("WITCHER.Chrome.ContextMenuActor.Text.AcceptsGifts", "Accepts Gifts");
  const rejectGiftsLabel  = t("WITCHER.Chrome.ContextMenuActor.Text.RejectGifts",  "Reject Gifts");
  if (entries.some(e => e?.name === acceptsGiftsLabel || e?.name === rejectGiftsLabel)) return;
  entries.push({
    name: acceptsGiftsLabel,
    icon: '<i class="fa-solid fa-gift"></i>',
    condition: (li) => {
      const actor = defaultResolveActor(li);
      return _canToggleAcceptsGifts(actor)
          && !actor.getFlag?.(MODULE_ID, "acceptsGifts");
    },
    callback: async (li) => {
      const actor = defaultResolveActor(li);
      if (!actor) return;
      await _flipAcceptsGifts(actor, true);
    }
  });
  entries.push({
    name: rejectGiftsLabel,
    icon: '<i class="fa-solid fa-hand"></i>',
    condition: (li) => {
      const actor = defaultResolveActor(li);
      return _canToggleAcceptsGifts(actor)
          && !!actor.getFlag?.(MODULE_ID, "acceptsGifts");
    },
    callback: async (li) => {
      const actor = defaultResolveActor(li);
      if (!actor) return;
      await _flipAcceptsGifts(actor, false);
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
    ui.notifications?.warn(tFormat("WITCHER.Notify.Status.NoneConfigured", { mod: MODULE_ID }, "{mod} | no status effects configured."));
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
    ui.notifications?.error(tFormat("WITCHER.Notify.DialogV2.Unavailable", { mod: MODULE_ID }, "{mod} | DialogV2 unavailable on this Foundry build."));
    return;
  }

  const dialog = await DialogV2.wait({
    window: { title: tFormat("WITCHER.Dialog.Status.Apply", { actor: actor.name }, "Apply Status — {actor}"), icon: ICON },
    content,
    buttons: [{ action: "close", label: t("WITCHER.Chrome.ContextMenuActor.Dialog.Button.Done", "Done"), default: true }],
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
            ui.notifications?.error(tFormat("WITCHER.Notify.Status.ApplyFailed", { id: id }, "Failed to apply status: {id}"));
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
            ui.notifications?.info(tFormat("WITCHER.Notify.Status.NoRemovable", { id: id }, "No removable {id} — wound-sourced instances clear when the wound is treated."));
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
