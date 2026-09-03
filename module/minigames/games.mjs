/**
 * Shared "Games" scene-control category.
 *
 * Both minigames (Farkle, Dice Poker) live under ONE left-bar category instead
 * of each owning a top-level icon. Clicking the category reveals its tools;
 * each tool is a momentary BUTTON (`button: true`) that toggles that game's
 * board for this user via the game's own `toggle*Board` entry point.
 *
 * Each tool is shown only when its homebrew toggle is enabled, so a world that
 * disables one game simply drops that button; disabling both hides the category.
 */

import { isHomebrewEnabled } from "../api/homebrew.mjs";
import { toggleFarkleBoard } from "./farkle/lobby.mjs";
import { toggleDicePokerBoard } from "./dicepoker/lobby.mjs";

export function registerGamesControl() {
    Hooks.on("getSceneControlButtons", (controls) => {
        const farkleOn = isHomebrewEnabled("farkleTable");
        const pokerOn = isHomebrewEnabled("dicePokerTable");
        if (!farkleOn && !pokerOn) return;

        const tools = {};
        if (farkleOn) {
            tools.farkle = {
                name: "farkle",
                order: 1,
                title: "WITCHER.Farkle.lobby.toggleTable",
                icon: "fa-solid fa-dice",
                button: true,
                onChange: () => toggleFarkleBoard()
            };
        }
        if (pokerOn) {
            tools.dicepoker = {
                name: "dicepoker",
                order: 2,
                title: "WITCHER.DicePoker.lobby.toggleTable",
                icon: "fa-solid fa-dice-d6",
                button: true,
                onChange: () => toggleDicePokerBoard()
            };
        }

        // NOTE: deliberately no `activeTool`. Foundry fires the active tool's
        // onChange when a control category is activated (scene-controls.mjs
        // #postActivate → #onToolChange). Since both tools are momentary
        // buttons, naming one as activeTool would auto-launch that game the
        // moment the Games category is clicked. With no non-button default,
        // Foundry sets the active tool to null and clicking the category just
        // reveals its children — the player then picks Farkle or Dice Poker.
        controls.games = {
            name: "games",
            order: 100,
            title: "WITCHER.Games.category",
            icon: "fa-solid fa-dice",
            visible: true,
            tools
        };
    });

    // The controls may have rendered their first pass before this hook was
    // registered (we run at "ready"); force one re-collect so the category
    // surfaces without a scene change.
    if (ui.controls?.rendered) ui.controls.render({ reset: true });
}
