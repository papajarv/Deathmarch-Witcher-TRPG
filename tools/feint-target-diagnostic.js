/**
 * Feint / Pirouette target-drift diagnostic.
 *
 * Paste into Foundry's F12 console AFTER a successful feint but BEFORE
 * the follow-up attack, with your Wolf token controlled and the intended
 * target still targeted. Prints whether the stored feint-advantage uuid
 * matches the currently-targeted actor's uuid — if they don't, the
 * follow-up attack won't get the +3 feint bonus (or +N Pirouette bonus)
 * because the code gates on the same target.
 */

(async () => {
    const SYS = "witcher-ttrpg-death-march";

    const attacker = canvas.tokens.controlled[0]?.actor
        ?? game.user.character;
    if (!attacker) {
        console.error("=== FEINT DIAGNOSTIC ===\nNo attacker — select a token or set your assigned character.");
        return;
    }

    const stored = attacker.getFlag(SYS, "feintAdvantage");
    const pirouette = Number(attacker.getFlag(SYS, "wr.pirouetteBonus")) || 0;
    const target = [...game.user.targets][0]?.actor;

    console.log("=== FEINT / PIROUETTE DIAGNOSTIC ===");
    console.log("Attacker:", attacker.name, "→", attacker.uuid);
    console.log("Stored feintAdvantage:", stored || "(none)");
    console.log("Stored wr.pirouetteBonus:", pirouette);
    console.log("Currently-targeted actor:", target?.name ?? "(none)", "→", target?.uuid ?? "(none)");

    if (!stored) {
        console.warn("→ No feintAdvantage flag stored. A successful feint should stamp this. Did the feint fire, land, or was it a MISS?");
        return;
    }
    if (!target) {
        console.warn("→ Nothing currently targeted. The follow-up attack will burn the feint advantage without applying the bonus (no target to compare against).");
        return;
    }
    if (stored === target.uuid) {
        const total = 3 + pirouette;
        console.log(`✓ Match. Follow-up attack against ${target.name} will get +${total} (base +3${pirouette ? ` + Pirouette +${pirouette}` : ""}).`);
    } else {
        console.warn("✗ MISMATCH — the stored uuid and the currently-targeted actor uuid differ.");
        console.warn(`  stored:  ${stored}`);
        console.warn(`  target:  ${target.uuid}`);
        console.warn("The follow-up attack against this target will burn the feint flag WITHOUT applying the +3. Possible causes:");
        console.warn("  1. You targeted a different token/actor than the one you feinted.");
        console.warn("  2. The token you feinted was destroyed / recreated / moved scenes between attacks.");
        console.warn("  3. Feint used the actor-target fallback (getActorTarget) while this check is using game.user.targets (or vice-versa).");
    }
})();
