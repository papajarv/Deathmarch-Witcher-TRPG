/**
 * Character ↔ linked-mount-actor wiring.
 *
 * Mechanism only (no DOM in here — the overlay's `.wou-mount-attach`
 * section in scripts/chrome/inventory.js renders the stats panel).
 *
 * Two ActiveEffects are managed:
 *
 *   1. **Item-side AE** (existing).  When a mount item is embedded on any
 *      actor, an AE on the item with `transfer: true` propagates the
 *      mount's `system.control` value into the actor's
 *      `system.skills.ref.riding.modifier` (the single per-skill modifier
 *      field folded into the skill total during prepareDerivedData).
 *
 *   2. **Character-mirror AE** (new).  When a character is linked to a
 *      monster actor via `flags.witcher-ttrpg-death-march.mountActorId` (the
 *      flag the inventory overlay already uses for saddlebag access), a
 *      mirror AE is created directly on the character carrying the control
 *      bonus from the linked monster's `system.mount.controlBonus` field
 *      (gated on `system.mount.isMount`).  Without this, the bonus would
 *      never reach the rider's Riding skill.
 *
 * Marker flags identify our managed AEs so we never touch effects the
 * user or other modules created:
 *   - on mount items:  flags.witcher-ttrpg-death-march.mountRidingMod  = true
 *   - on characters:   flags.witcher-ttrpg-death-march.mountMirrorMod  = true
 */

const MODULE_ID         = "witcher-ttrpg-death-march";
const MOUNT_FLAG        = "mountActorId";     /* set by inventory.js when linking */
const MOUNT_AE_FLAG     = "mountRidingMod";   /* identifies the item-side AE */
const MIRROR_AE_FLAG    = "mountMirrorMod";   /* identifies the character-mirror AE */

/* The skills schema (data/actor/templates/skills.mjs) exposes a single
 * `modifier` number per skill, folded into the skill total in
 * CharacterData.prepareDerivedData. AE ADD mode lands here before derived
 * data runs, so the mount bonus flows straight into the riding total. */
const RIDING_KEY = "system.skills.ref.riding.modifier";

/* =========================================================================
   ITEM-SIDE AE — `transfer: true`, propagates to the item's parent actor
   ========================================================================= */

Hooks.on("createItem", (item) => {
  if (item.type === "mount") ensureMountItemRidingMod(item).catch(noop);
});

Hooks.on("updateItem", (item, changes) => {
  if (item.type !== "mount") return;
  if (changes?.system && "control" in changes.system) ensureMountItemRidingMod(item).catch(noop);
  else if (changes?.name)                              ensureMountItemRidingMod(item).catch(noop);
});

async function ensureMountItemRidingMod(item) {
  if (!item?.parent) return;
  if (!["character", "monster"].includes(item.parent.type)) return;
  if (!item.parent.isOwner) return;

  const ctrl  = Number(item.system?.control);
  const value = Number.isFinite(ctrl) ? ctrl : 0;

  const existing = item.effects.find(e => e.getFlag?.(MODULE_ID, MOUNT_AE_FLAG));

  if (value === 0) {
    if (existing) await existing.delete();
    return;
  }

  const desiredChanges = [{
    key: RIDING_KEY,
    type: "add",
    value: String(value),
    priority: null
  }];

  if (existing) {
    const cur = existing.changes?.[0];
    const same = cur
      && cur.key === desiredChanges[0].key
      && Number(cur.value) === value
      && cur.type === desiredChanges[0].type
      && existing.name === `Mount Control · ${item.name}`;
    if (!same) {
      await existing.update({
        name: `Mount Control · ${item.name}`,
        changes: desiredChanges,
        disabled: false
      });
    }
    return;
  }

  await item.createEmbeddedDocuments("ActiveEffect", [{
    name: `Mount Control · ${item.name}`,
    img:  "icons/environment/creatures/horse-brown.webp",
    transfer: true,
    flags: { [MODULE_ID]: { [MOUNT_AE_FLAG]: true } },
    changes: desiredChanges
  }]);
}

/* =========================================================================
   CHARACTER-MIRROR AE — applied directly on the character when they have
   a linked mount actor whose embedded mount item carries a control value
   ========================================================================= */

/** Read the control bonus that a character should currently receive from
 *  their linked mount actor.  The source of truth is the monster's
 *  `system.mount.controlBonus` field (editable on the monster sheet), gated
 *  on `system.mount.isMount`.  Returns 0 if no link or the linked actor
 *  isn't flagged as a mount. */
function getLinkedControlValue(character) {
  if (!character) return 0;
  const linkedId = character.getFlag?.(MODULE_ID, MOUNT_FLAG);
  if (!linkedId) return 0;
  const linked = game.actors?.get?.(linkedId);
  if (!linked) return 0;
  if (!linked.system?.mount?.isMount) return 0;
  const n = Number(linked.system?.mount?.controlBonus);
  return Number.isFinite(n) ? n : 0;
}

/** Ensure the character has exactly one mirror AE matching the linked
 *  mount's control value.  Removes the AE when value is 0 or no link. */
async function syncCharacterRidingMod(character) {
  if (!character || character.type !== "character") return;
  if (!character.isOwner) return;

  const value = getLinkedControlValue(character);
  const existing = character.effects.find(e => e.getFlag?.(MODULE_ID, MIRROR_AE_FLAG));

  if (value === 0) {
    if (existing) await existing.delete();
    return;
  }

  const desiredChanges = [{
    key: RIDING_KEY,
    type: "add",
    value: String(value),
    priority: null
  }];

  if (existing) {
    const cur = existing.changes?.[0];
    const same = cur
      && cur.key === desiredChanges[0].key
      && Number(cur.value) === value
      && cur.type === desiredChanges[0].type;
    if (!same) {
      await existing.update({
        name: `Mount Control · (linked mount)`,
        changes: desiredChanges,
        disabled: false
      });
    }
    return;
  }

  await character.createEmbeddedDocuments("ActiveEffect", [{
    name: `Mount Control · (linked mount)`,
    img:  "icons/environment/creatures/horse-brown.webp",
    transfer: false,  /* lives directly on the character */
    flags: { [MODULE_ID]: { [MIRROR_AE_FLAG]: true } },
    changes: desiredChanges
  }]);
}

/* Trigger: character's mountActorId flag changed (linked / unlinked) */
Hooks.on("updateActor", (actor, changes) => {
  if (actor.type !== "character") return;
  if (!actor.isOwner) return;
  /* Cheap heuristic: any flag update under our namespace re-syncs.  Cheaper
   * than walking `changes` deeply; the no-op fast-paths inside sync() make
   * spurious re-sync harmless. */
  const flagsChanged = foundry.utils.hasProperty(changes, `flags.${MODULE_ID}`);
  if (flagsChanged) syncCharacterRidingMod(actor).catch(noop);
});

/* Trigger: linked monster's embedded mount item changes (control edited,
 * item added / removed).  Walk world characters linked to this monster
 * and re-sync each one. */
Hooks.on("createItem",  (item) => onMountItemTouched(item));
Hooks.on("updateItem",  (item, changes) => onMountItemTouched(item, changes));
Hooks.on("deleteItem",  (item) => onMountItemTouched(item));

function onMountItemTouched(item /*, changes */) {
  if (!item || item.type !== "mount") return;
  const monster = item.parent;
  if (!monster || monster.type !== "monster") return;
  /* Re-sync every character linked to this monster. */
  for (const char of game.actors?.contents ?? []) {
    if (char.type !== "character") continue;
    if (!char.isOwner) continue;
    if (char.getFlag?.(MODULE_ID, MOUNT_FLAG) === monster.id) {
      syncCharacterRidingMod(char).catch(noop);
    }
  }
}

/* Trigger: linked monster updated in some way (e.g. items array rebuilt) —
 * cheaper to walk-and-resync than diff the change set. */
Hooks.on("updateActor", (actor) => {
  if (actor.type !== "monster") return;
  for (const char of game.actors?.contents ?? []) {
    if (char.type !== "character") continue;
    if (!char.isOwner) continue;
    if (char.getFlag?.(MODULE_ID, MOUNT_FLAG) === actor.id) {
      syncCharacterRidingMod(char).catch(noop);
    }
  }
});

/* Trigger: linked monster deleted — unset the flag on any characters that
 * pointed at it so the panel + AE collapse cleanly. */
Hooks.on("deleteActor", async (actor) => {
  if (!actor || actor.type !== "monster") return;
  for (const char of game.actors?.contents ?? []) {
    if (char.type !== "character") continue;
    if (!char.isOwner) continue;
    if (char.getFlag?.(MODULE_ID, MOUNT_FLAG) === actor.id) {
      await char.unsetFlag(MODULE_ID, MOUNT_FLAG).catch(() => {});
    }
  }
});

function noop() {}

/* Public API for inventory.js to read the linked control value cheaply */
export function getLinkedMountControl(character) {
  return getLinkedControlValue(character);
}
