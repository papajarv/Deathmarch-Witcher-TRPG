import { t, tFormat } from "../chrome/lib/i18n.js";
/**
 * canvas-additive-targeting — override Foundry's T-key to stack targets.
 *
 * Default Foundry: pressing T on a hovered token targets it with
 * `releaseOthers: true`, dropping every existing target. Shift+T is
 * the additive variant. Death-march combat routinely wants multi-
 * target (Aard vs 4 grunts, Igni cone vs a spider stack) so the
 * default is inverted here: T is ALWAYS additive (toggle-on-hover),
 * matching how the combat tracker's right-click and the token
 * middle-click already behave.
 *
 * Registered at PRIORITY precedence so this fires ahead of core's
 * own binding on the same physical key and consumes the event. When
 * no token is hovered we return false and let core handle the press
 * (Foundry's own T also does nothing without a hover — same UX).
 */

const SYSTEM_ID = "witcher-ttrpg-death-march";

/** Register the T-key override.  MUST be called during the `init` hook
 *  — Foundry stops accepting keybinding registrations after init closes.
 *  Called from main.mjs's own init handler, not from registerHooks()
 *  (which runs later, during setup). */
export function registerAdditiveTargeting() {
    try {
        game.keybindings.register(SYSTEM_ID, "additiveTarget", {
            name: t("WITCHER.Policy.CanvasAdditiveTargeting.Text.TargetHoveredTokenAdditive", "Target Hovered Token (Additive)"),
            hint: t("WITCHER.Policy.CanvasAdditiveTargeting.Hint.TargetHovered", "Toggle target on the hovered token without releasing existing targets. Overrides Foundry's default replace-on-target so multi-target casts and attacks stack cleanly."),
            editable: [{ key: "KeyT" }],
            precedence: CONST.KEYBINDING_PRECEDENCE?.PRIORITY ?? 2,
            onDown: () => {
                /* Manual canvas token target-lock is disabled — canvas
                 * targeting is driven by the weapon → tile flow, and manual
                 * lock survives only in theatre-of-the-mind. We keep the
                 * binding registered (at PRIORITY) purely to SHADOW Foundry's
                 * native T-target so pressing T on the canvas does nothing
                 * rather than falling through to core's replace-on-target. */
                return true;
            }
        });
    } catch (err) {
        console.warn(`${SYSTEM_ID} | keybinding register failed`, err);
    }
}
