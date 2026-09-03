/**
 * The cast roll's formula. A leaf module on purpose.
 *
 * This lives apart from the adapter so it can be tested without dragging in
 * the system's setup chain and its Foundry globals — and it needs testing,
 * because the bug it encodes was invisible for the life of the engine:
 *
 * The cast dialog's `grandMod` is the COMPLETE to-cast modifier. It is built
 * as `baseTotal + extraPenalty + otherMod + focus + glyph`, and `baseTotal` is
 * the caster's full skill total (governing stat + rank). The adapter used to
 * add `skillTotal()` on top of it, so every authored cast rolled the caster's
 * skill twice: a WILL 8 / Spell Casting 8 mage read "1d10 +16" on the dialog
 * and then rolled 1d10+24. The legacy path rolls `1d10 + grandMod` and was
 * always correct, so only spells with authored blocks were inflated — which
 * is exactly the comparison nobody was making.
 *
 * `base` is therefore the whole modifier. Nothing may be added to it here.
 */
export function castFormula(base, adrenalineDice = 0) {
    const n = Number(base) || 0;
    const adr = Number(adrenalineDice) || 0;
    /* "1d10 + -3" parses, but reads as a typo on the card. */
    return `1d10 ${n < 0 ? "-" : "+"} ${Math.abs(n)}${adr ? ` + ${adr}d6` : ""}`;
}
