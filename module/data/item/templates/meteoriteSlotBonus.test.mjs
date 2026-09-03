// Meteorite quality (EO p.7) grants +1 enhancement slot, capped at 3 total.
// The derivation lives in enhancementDerivation.deriveWeaponEffective and
// the sheet reads `effective.bonusSlots`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const derivSrc = readFileSync(new URL("./enhancementDerivation.mjs", import.meta.url), "utf8");
const sheetSrc = readFileSync(new URL("../../../sheets/item/base.mjs", import.meta.url), "utf8");

test("deriveWeaponEffective folds meteoriteExtraEnchantSlot into bonusSlots", () => {
    assert.match(derivSrc, /cat\[q\]\?\.meteoriteExtraEnchantSlot/);
    assert.match(derivSrc, /bonusSlots:\s*bonusSlotsClamped/);
});

test("bonusSlots is capped so total slot count never exceeds 3", () => {
    // The clamp uses (3 - baseSlots) as the upper bound.
    assert.match(derivSrc, /3\s*-\s*baseSlots/);
});

test("WeaponSheet reads effective.bonusSlots when building the slot UI", () => {
    assert.match(sheetSrc, /effective\?\.bonusSlots/);
    assert.match(sheetSrc, /baseSlots\s*\+\s*bonusSlots/);
});

test("Feeble/Hefty block-through chat-card riders fire on a successful Block", () => {
    const mixinSrc = readFileSync(new URL("../../../documents/mixins/weaponAttackMixin.mjs", import.meta.url), "utf8");
    /* Both Hefty (attacker) and Feeble (defender) branches must call
     * appendAttackResult with an info fragment after the block was won
     * by the defender (delta < 0). */
    assert.match(mixinSrc, /attkQ\.has\("hefty"\)[\s\S]+?appendAttackResult/);
    assert.match(mixinSrc, /blockerFeeble\s*&&\s*!attkQ\.has\("feeble"\)[\s\S]+?appendAttackResult/);
    /* Feeble is now RESOLVED (not just noted): the branch applies the leaked
     * half-damage through armour via applyFeebleLeak, and a Sturdy/Very Sturdy
     * block item exempts the Hefty block-through. */
    assert.match(mixinSrc, /applyFeebleLeak/);
    assert.match(mixinSrc, /blockCountersHefty/);
});
