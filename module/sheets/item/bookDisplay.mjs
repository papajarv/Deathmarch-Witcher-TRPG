/**
 * Shared book display-context builder.
 *
 * The book's category label (its display subtitle), derived from bookConfig. Used
 * by BOTH the book item sheet (WitcherBookSheet) and the inventory inspect panel so
 * the two can't drift. Synchronous — no lazy imports needed.
 */

const BOOK_TYPE_LABELS = { monster: "Monster Lore", skill: "Skill", stress: "Novel / Lore" };

export function buildBookDisplay(item) {
    const src = item?.toObject?.()?.system ?? item?.system ?? {};
    const bookType = src?.bookConfig?.bookType ?? "monster";
    return { bookType, bookTypeLabel: BOOK_TYPE_LABELS[bookType] ?? BOOK_TYPE_LABELS.monster };
}
