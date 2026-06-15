/**
 * Map valuable helpers.
 *
 * A Map is a valuable with `system.type === "map"`. Its image lives on the
 * first-class field `system.mapImage` (configured from the item sheet's Map
 * panel). The map overlay in chrome/chrome/map.js reads it via getMapImage().
 *
 * The subtype select and the image picker are owned by the bespoke valuable
 * sheet (templates/item/valuable.hbs) — this file no longer injects anything
 * into the sheet. It only exposes the two read helpers the display layer uses.
 */

const MODULE_ID = "witcher-ttrpg-death-march";
const LEGACY_ID = "witcher-overhaul-ui";
const MAP_TYPE_SLUG = "map";

/** True if the item is a Map valuable. */
export function isMapItem(item) {
  return item?.type === "valuable"
      && String(item?.system?.type ?? "").toLowerCase() === MAP_TYPE_SLUG;
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
