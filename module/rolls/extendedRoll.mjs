/**
 * extendedRoll — Witcher TRPG d10 roll with explode/fumble.
 *
 * Witcher TRPG dice rule:
 *   - Roll 1d10
 *   - On a natural 10, roll again and ADD; repeat while rolling 10s
 *   - On a natural 1, it's a FUMBLE: the die does NOT implode (no roll-and-
 *     subtract). The roll is flagged as a fumble and the player resolves it on
 *     the fumble table — see fumble-dialog.js. (House rule: per user spec we no
 *     longer auto-explode the die downward.)
 *
 * The wrapping `extendedRoll(formula, ...)` pulls the leading `1d10` out
 * of the formula, applies Witcher dice rules to it, evaluates the static
 * modifier remainder via Foundry's Roll, sums, and posts a chat message.
 *
 * The chat card shows the dice chain (initial / explosions / fumbles) so
 * players can audit the roll.
 */

/**
 * Roll one d10 and return its face value.
 * Uses Foundry's Roll so DSN / sound / settings interactions stay native.
 */
async function rollOneD10() {
    const r = await new Roll("1d10").evaluate();
    return r.total;
}

/**
 * Roll a Witcher-style d10 chain.
 * Returns { total, dice: [{ value, kind }], fumble } where kind ∈
 * "initial" | "explode" | "fumble". A natural 1 sets `fumble` true but does
 * NOT implode the die (no downward explosion) — it stays at 1.
 */
export async function rollWitcherD10() {
    const dice = [];
    const first = await rollOneD10();
    let total = first;
    let fumble = false;

    if (first === 10) {
        dice.push({ value: first, kind: "initial" });
        let next;
        do {
            next = await rollOneD10();
            dice.push({ value: next, kind: "explode" });
            total += next;
        } while (next === 10);
    } else if (first === 1) {
        // Fumble: flag it, but leave the die at 1 (no roll-and-subtract).
        dice.push({ value: first, kind: "fumble" });
        fumble = true;
    } else {
        dice.push({ value: first, kind: "initial" });
    }

    return { total, dice, fumble };
}

/**
 * Strip the leading `1d10` from a roll formula, returning the modifier
 * portion. Defensive: handles "1d10", "1d10 + X", "1d10+X", and the
 * Witcher-overhaul pattern "1d10 +(X)".
 */
function splitFormula(formula) {
    const trimmed = String(formula ?? "1d10").trim();
    const m = trimmed.match(/^\s*1d10\b\s*(.*)$/i);
    if (!m) return { hasDie: false, modifier: trimmed };
    return { hasDie: true, modifier: m[1].trim() };
}

/**
 * Evaluate the static modifier portion. Returns 0 if empty.
 */
async function evalModifier(modifierExpr, rollData) {
    if (!modifierExpr) return 0;
    // Strip leading "+" if present, normalize "+(...)" wrapping
    let expr = modifierExpr.replace(/^\+\s*/, "");
    if (expr === "" || expr === "0") return 0;
    try {
        const r = await new Roll(expr, rollData ?? {}).evaluate();
        return r.total;
    } catch (e) {
        console.error("witcher-ttrpg-death-march | extendedRoll: bad modifier", expr, e);
        return 0;
    }
}

/**
 * Build a chat card body summarizing the dice chain + total.
 * Caller may pass extra flavor HTML via `messageData.flavor`.
 */
function buildChatContent({ dieTotal, modifierTotal, finalTotal, dice, config, fumble }) {
    const chain = dice.map(d => {
        const cls = d.kind === "explode" ? "wdm-die-explode"
                  : d.kind === "fumble"  ? "wdm-die-fumble"
                  :                        "wdm-die";
        return `<span class="${cls}">${d.value}</span>`;
    }).join(" ");

    let result = `
        <div class="wdm-roll">
            <div class="wdm-roll-line">
                <span class="wdm-roll-d10">d10</span>
                <span class="wdm-roll-dice">${chain}</span>
                ${modifierTotal ? `<span class="wdm-roll-mod">${modifierTotal >= 0 ? "+" : "−"}${Math.abs(modifierTotal)}</span>` : ""}
                <span class="wdm-roll-eq">=</span>
                <span class="wdm-roll-total">${finalTotal}</span>
            </div>`;

    if (fumble) {
        result += `<div class="wdm-roll-fumble">
                       <i class="fa-solid fa-triangle-exclamation"></i>
                       <span>${game.i18n.localize("WITCHER.Roll.Fumble")}</span>
                   </div>`;
    }

    if (config?.threshold != null) {
        // `rollUnder` flips the comparison for roll-under saves (stun / death,
        // Core p.47/162): RAW says "roll under this number", so success is
        // rolling STRICTLY UNDER the target — a roll equal to it fails. A
        // natural 10 still explodes upward (past any threshold — a fail); a
        // natural 1 no longer implodes but a flat 1 is already below any
        // meaningful threshold, so it still passes.
        const pass = config.rollUnder ? finalTotal < config.threshold : finalTotal >= config.threshold;
        const msg = pass
            ? (config.messageOnSuccess ?? "Success")
            : (config.messageOnFailure ?? "Failure");
        result += `<div class="wdm-roll-result ${pass ? "pass" : "fail"}">
                       <span class="wdm-roll-dc">${config.rollUnder ? "&lt;" : "DC"} ${config.threshold}</span>
                       <span class="wdm-roll-verdict">${msg}</span>
                   </div>`;
    }
    result += `</div>`;
    return result;
}

/**
 * Main entry point used by actor/item code.
 *
 * @param {string} formula  e.g. "1d10 + 5 + 3" or "1d10"
 * @param {object} messageData  { speaker, flavor }
 * @param {object} config  optional: { threshold, messageOnSuccess,
 *                          messageOnFailure, rollData }
 */
export async function extendedRoll(formula, messageData = {}, config = {}) {
    const { hasDie, modifier } = splitFormula(formula);

    let dieTotal = 0;
    let dice = [];
    let fumble = false;
    if (hasDie) {
        const rolled = await rollWitcherD10();
        dieTotal = rolled.total;
        dice = rolled.dice;
        fumble = rolled.fumble;
    }

    const modifierTotal = await evalModifier(modifier, config.rollData);
    const finalTotal = dieTotal + modifierTotal;

    const flavor = messageData.flavor ?? "";
    const body = buildChatContent({ dieTotal, modifierTotal, finalTotal, dice, config, fumble });

    /* messageMode (v14 visibility key: public|gm|blind|self|ic|emote) routes
     * the card to whispers/blind. Omit it for the default public card. */
    const createOpts = messageData.messageMode ? { messageMode: messageData.messageMode } : {};
    await ChatMessage.create({
        speaker: messageData.speaker ?? ChatMessage.getSpeaker(),
        content: `${flavor}${body}`,
        rolls:   []
    }, createOpts);

    if (fumble) ui.notifications?.warn(game.i18n.localize("WITCHER.Roll.FumbleWarning"));

    return { total: finalTotal, dieTotal, modifierTotal, dice, fumble };
}
