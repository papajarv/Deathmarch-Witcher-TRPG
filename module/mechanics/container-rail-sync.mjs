/**
 * Container rail ⇄ equipped sync (the equipped→rail half).
 *
 * The rail→equipped half lives in `chrome/lib/container.js`
 * (`setRailAssignment` reflects membership onto `system.equipped`). This
 * handler covers the other direction: toggling a container's equipped flag
 * by hand puts it on the rail (first free slot, growing the rail if full)
 * or pulls it off. Guarded writes on both sides prevent a feedback loop.
 */

import {
  getRail, setRailCount, setRailAssignment, isContainerRailed, railSlotOf,
} from "../chrome/lib/container.js";

export async function onUpdateContainerEquip(item, changed, _options, userId) {
  if (userId !== game.user?.id) return;
  if (item?.type !== "container") return;
  if (!foundry.utils.hasProperty(changed, "system.equipped")) return;
  const actor = item.parent;
  if (!actor) return;

  const equipped = !!item.system?.equipped;
  const railed = isContainerRailed(actor, item.id);
  if (equipped === railed) return;

  if (equipped) {
    let rail = getRail(actor);
    let free = rail.assignments.indexOf(null);
    if (free < 0) {
      await setRailCount(actor, rail.count + 1);
      rail = getRail(actor);
      free = rail.assignments.indexOf(null);
    }
    if (free >= 0) await setRailAssignment(actor, free, item.id);
  } else {
    const slot = railSlotOf(actor, item.id);
    if (slot >= 0) await setRailAssignment(actor, slot, null);
  }
}
