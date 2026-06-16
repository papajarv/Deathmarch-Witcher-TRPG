/**
 * Food consume — registers an "Eat" / "Drink" item action for the food
 * type (homebrew foodAndDrink). The action routes through `item.consume()`,
 * which is the mixin entry point — that delegates to
 * `mechanics/foodAndDrink.onConsume` (taste-in-chat, satiety restore,
 * charge tick, alcohol Endurance roll) and falls back to the base
 * quantity-decrement when needed.
 *
 * Parallel to chrome/policy/consume-item.js, which handles alchemical
 * doses; food is a separate path so the conditions don't overlap and
 * either action shows up independently in the context menu.
 */

import { registerItemAction } from "../chrome/context-menu-item.js";
import { isHomebrewEnabled } from "../../api/homebrew.mjs";

/* The action label depends on the food's `kind`: drinks "Drink", everything
 * else "Eat". Falls back to "Consume" if the kind is somehow missing. */
function actionLabelFor(item) {
    const kind = item?.system?.kind;
    if (kind === "drink") return "Drink";
    if (kind === "meal") return "Eat";
    return "Consume";
}

let _installed = false;
export function installFoodConsumeFeature() {
    if (_installed) return;
    _installed = true;

    registerItemAction({
        // Label is dynamic per item; the context menu reads `.name` once at
        // build time per row, so we return a fixed label here and let the
        // condition gate render the right verb in the tooltip / chat by
        // routing through item.consume(). The label "Consume" is generic
        // enough to read sensibly for all three kinds.
        name: "Consume",
        icon: '<i class="fa-solid fa-utensils"></i>',
        // Owned-dose action — only on the actor sheet / chrome inventory
        // overlay, never the world Items sidebar (a template has no dose).
        surfaces: { sidebar: false },
        condition: (item) => {
            if (!item || item.type !== "food") return false;
            // Homebrew gate: if foodAndDrink is off, the consume side-effects
            // (satiety / charges / alcohol) are no-ops anyway, and offering
            // a "Consume" action on a food item the world doesn't recognize
            // would be confusing. Hide the entry.
            if (!isHomebrewEnabled("foodAndDrink")) return false;
            return true;
        },
        callback: async (item, actor) => {
            if (!actor) {
                ui.notifications?.warn(`Assign a character (in your User Configuration) to consume ${item.name}.`);
                return;
            }
            // Belt-and-braces: the mixin's `consume()` is async and routes
            // through foodAndDrink.onConsume → taste, satiety, charges,
            // alcohol. The label `actionLabelFor` is purely informational
            // for any caller that wants to surface the right verb.
            try {
                await item.consume?.();
            } catch (err) {
                console.error(`witcher-ttrpg-death-march | food consume failed`, err);
                ui.notifications?.error(`${actionLabelFor(item)} failed — see console.`);
            }
        }
    });
}
