/**
 * WitcherLootSheet — inert loot pile actor sheet.
 *
 * Hook name: `renderWitcherLootSheet`.
 */

import { WitcherActorSheet } from "./base.mjs";

export class WitcherLootSheet extends WitcherActorSheet {

    static DEFAULT_OPTIONS = {
        classes: [...WitcherActorSheet.DEFAULT_OPTIONS.classes, "loot"],
        position: { width: 540, height: 480 }
    };

    static PARTS = {
        main: {
            template: "systems/witcher-ttrpg-death-march/templates/actor/loot/main.hbs",
            scrollable: [""]
        }
    };
}
