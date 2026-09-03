/**
 * A choice id, in words a person reads.
 *
 * `core:chooseOption` offers whatever list an author typed, and those are
 * identifiers: `searTheHolder`, `lightningStorm`, `dropIt`. They reached the
 * table unchanged — a dropdown offering "lightningStorm", a chat card
 * announcing "The weather turns to lightningStorm".
 *
 * The old helper tried to translate and fell back with `?? id`, which never
 * fired: Foundry's `localize` returns the KEY when there is no translation, so
 * a missing key put "WITCHER.Magic.Choice.searTheHolder" on screen instead.
 *
 * A translation wins where one exists. Otherwise the id is turned back into
 * the words it was made from — because an author inventing a choice, which is
 * the entire point of a block library, must not have to add a lang key before
 * the table can read what they wrote.
 *
 * Foundry-free on purpose: `game` is passed in, so this is testable and so the
 * rule lives somewhere a test can reach without a browser.
 */
export function localiseChoice(id, i18n = globalThis.game?.i18n) {
    const key = `WITCHER.Magic.Choice.${id}`;
    if (i18n?.has?.(key)) return i18n.localize(key);
    return humanise(id);
}

/**
 * `searTheHolder` → `sear the holder`.
 *
 * Lower case, because these are read MID-SENTENCE far more often than they are
 * read alone: "You take the shape of a {shape}", "The weather turns to
 * {weather}". Capitalising here produced "the shape of a A serpent". Whoever
 * shows one on its own — the dialog's dropdown — capitalises it there.
 */
export function humanise(id) {
    return String(id ?? "")
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/[_-]+/g, " ")
        .trim()
        .toLowerCase();
}

/** For a label standing on its own, such as a dropdown entry. */
export function forDisplay(label) {
    return String(label ?? "").replace(/^./, (m) => m.toUpperCase());
}

/**
 * For a label read INSIDE a sentence.
 *
 * The shipped translations are written as dropdown entries — "A serpent",
 * "Clear sky", "Make them drop it" — which is right where they are read alone
 * and wrong everywhere else: "You take the shape of a A serpent". The article
 * belongs to the label, so the sentence must not supply one, and the capital
 * belongs to the list, so the sentence lowers it.
 *
 * Only the first letter, and only when the rest of the word is not itself
 * capitalised — so a name stays a name.
 */
export function inSentence(label) {
    const s = String(label ?? "");
    /* Any capital AFTER the first character means the label carries its own
     * capitalisation — an acronym (DEX), a name (McGregor), a proper noun —
     * and lowering the first letter would damage it. A plain dropdown entry
     * ("A serpent", "Make them drop it") has none. */
    if (/[A-Z]/.test(s.slice(1))) return s;
    return s.replace(/^./, (m) => m.toLowerCase());
}
