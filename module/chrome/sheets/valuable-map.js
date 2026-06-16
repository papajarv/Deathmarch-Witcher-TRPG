/**
 * Map item helpers.
 *
 * A Map is now a first-class Foundry Item type (`item.type === "map"`). Its
 * image lives on the schema field `system.mapImage` (configured from the
 * item sheet's Map panel — the shared valuable sheet branches by document
 * type). The map overlay in chrome/chrome/map.js reads it via getMapImage().
 *
 * Previously a valuable subtype; promoted to its own type so the categorizer
 * and the sheet routing no longer need the `valuable + system.type === "map"`
 * two-step. This file just exposes the two read helpers the display layer
 * uses.
 */

const MODULE_ID = "witcher-ttrpg-death-march";
const LEGACY_ID = "witcher-overhaul-ui";

/** True if the item is a Map. */
export function isMapItem(item) {
  return item?.type === "map";
}

/** Read the configured map image URL for a Map item (or empty string).
 *  Canonical source is system.mapImage; legacy flag namespaces are read as a
 *  fallback for dev worlds that predate the system-field unification. */
export function getMapImage(item) {
  return String(
    item?.system?.mapImage
    ?? item?.flags?.[MODULE_ID]?.mapImage
    ?? item?.flags?.[LEGACY_ID]?.mapImage
    ?? ""
  );
}
