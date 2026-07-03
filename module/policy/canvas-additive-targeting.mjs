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
            name: "Target Hovered Token (Additive)",
            hint: "Toggle target on the hovered token without releasing existing targets. Overrides Foundry's default replace-on-target so multi-target casts and attacks stack cleanly.",
            editable: [{ key: "KeyT" }],
            precedence: CONST.KEYBINDING_PRECEDENCE?.PRIORITY ?? 2,
            onDown: () => {
                const token = canvas?.tokens?.hover;
                if (!token?.setTarget) return false;
                const wasTargeted = !!game.user?.targets?.has?.(token);
                try {
                    token.setTarget(!wasTargeted, {
                        user:           game.user,
                        releaseOthers:  false,
                        groupSelection: false
                    });
                    return true;
                } catch (err) {
                    console.warn(`${SYSTEM_ID} | additive target keybinding failed`, err);
                    return false;
                }
            }
        });
    } catch (err) {
        console.warn(`${SYSTEM_ID} | keybinding register failed`, err);
    }
}
