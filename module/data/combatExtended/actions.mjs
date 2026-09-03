/**
 * Combat Extended — combat-actions catalog.
 *
 * Single source of truth for every attack and defense action exposed under
 * the Combat Extended homebrew toggle. The defaults seed straight from the
 * "Combat Extended" homebrew rules (see DEATHMARCH_PUBLIC/rules1.png +
 * rules2.png and the Equipment Overhaul framework chapter). GMs reshape
 * each entry through the Combat Actions Editor (applications/combatActions
 * Editor.mjs) — the editor writes an override object into the
 * `combatActionsOverride` world setting, which `getActiveCombatActions`
 * merges over the defaults at read time.
 *
 *   defaults  →  override (per-key shallow merge)  →  active table
 *
 * Engine consumers (attackDialog, weaponAttackMixin, defenseMixin, dock)
 * MUST go through `getActiveCombatActions()` rather than importing the
 * defaults directly, so editor changes take effect without a reload of
 * those modules. Schema is JSON-safe (no functions, no class instances)
 * so override-round-tripping through the setting object is lossless.
 *
 * Schema (per action entry):
 *
 *   kind          "attack" | "defense"
 *   labelKey      i18n key for the display label
 *   descKey       i18n key for the long description (chat-card rider note
 *                 + editor table). The editor lets the GM override the
 *                 *value*, not the key — overrides store the literal text
 *                 under the override map.
 *   staCost       per-use STA cost (additive recurrence rule for defenses
 *                 lives in defenseMixin, not here)
 *   toHit         flat to-hit modifier (attacks only; ignored for defenses)
 *   dmgMult       damage multiplier (attacks only; 0 = noDamage)
 *   attacks       roll count (Fast = 2, Joint = 2, otherwise 1)
 *   meleeOnly     melee weapons only (Special Attacks bucket)
 *   meleeOrBow    melee OR bow ammo (Strong / Fast — not crossbows)
 *   noDamage      attack lands but applies no damage roll
 *   nonLethal     damage is non-lethal
 *   fullRound     consumes the whole round (Charge / Lunge)
 *   offhand       requires picking a second weapon (Joint Attack)
 *   firstRollSkill  override the first roll's skill (Feint = Deceit)
 *   requiresPiercing  attack requires a Piercing damage type (Impale, Lunge)
 *   requiresShield    attack requires an equipped shield (Bash)
 *   prereq        runtime gate — "grappling" / "" (Pin / Chokehold /
 *                 Ride require grappling). Escape is not an action —
 *                 movement out of the clincher's reach breaks the
 *                 pair automatically via the movement hook.
 *   penalty       defense roll modifier (defenses only — Parry = -3)
 *   defenseSkill  "weapon" | "dodge" | "athletics" | "brawling"
 *                 (defenses only; "weapon" = the wielded item's skillKey)
 *   note          unused placeholder for editor-authored extra text
 *
 * Schema additions live alongside their consumer — DO NOT add fields here
 * just because they're referenced by another layer. New mechanic hooks land
 * with the layer that consumes them.
 */

import { isCESubsystemEnabled } from "../../api/homebrew.mjs";

const SYSTEM_ID = "witcher-ttrpg-death-march";

/* Default catalog. Object.freeze on the outer wrapper + every leaf so a
 * misbehaving consumer can't accidentally mutate the defaults at runtime. */
export const DEFAULT_COMBAT_ACTIONS = Object.freeze({
    /* ── Attacks ─────────────────────────────────────────────────────── */
    single: Object.freeze({
        kind: "attack",
        labelKey: "WITCHER.CombatExtended.Action.Single",
        descKey:  "WITCHER.CombatExtended.Action.SingleDesc",
        staCost: 1, toHit: 0, dmgMult: 1, attacks: 1
    }),
    /* STA-cost rule (CE 2026-07-03): every attack action costs 1 STA
     * EXCEPT Strong / Fast / Joint (2 STA each). The three exceptions
     * are the "high-value" swings; everything else is the baseline. */
    strongAttack: Object.freeze({
        kind: "attack",
        labelKey: "WITCHER.CombatExtended.Action.Strong",
        descKey:  "WITCHER.CombatExtended.Action.StrongDesc",
        staCost: 2, toHit: -3, dmgMult: 2, attacks: 1, meleeOrBow: true
    }),
    fastAttack: Object.freeze({
        kind: "attack",
        labelKey: "WITCHER.CombatExtended.Action.Fast",
        descKey:  "WITCHER.CombatExtended.Action.FastDesc",
        staCost: 2, toHit: 0, dmgMult: 1, attacks: 2, meleeOrBow: true
    }),
    jointAttack: Object.freeze({
        kind: "attack",
        labelKey: "WITCHER.CombatExtended.Action.Joint",
        descKey:  "WITCHER.CombatExtended.Action.JointDesc",
        staCost: 2, toHit: -3, dmgMult: 1, attacks: 2, meleeOnly: true, offhand: true
    }),
    /* CE Feint: identical to RAW Feint (Core p.163) except the
     * attacker rolls their WEAPON SKILL vs the target's Awareness
     * instead of Deceit vs Awareness. On a successful check, the
     * attacker's NEXT attack against the same target gets +3 to hit.
     * All the shared feint plumbing (defense-prompt bypass, card
     * retitled to "Feint", called-shot penalty strip, feintAdvantage
     * flag write, Pirouette rider) is triggered by the shared
     * `isFeintRoll` gate in weaponAttackMixin — the only distinction
     * from RAW is the missing `firstRollSkill: "deceit"` here (its
     * absence routes the roll through the normal weapon profile). */
    feint: Object.freeze({
        kind: "attack",
        labelKey: "WITCHER.CombatExtended.Action.Feint",
        descKey:  "WITCHER.CombatExtended.Action.FeintDesc",
        staCost: 1, toHit: 0, dmgMult: 1, attacks: 1, meleeOnly: true,
        noDamage: true
    }),
    /* Clinch — Move-budget action (EO p.5 "The Clinch"). Initiated from the
     * Move-action menu on the dock; consumes Move, no STA, no roll, no
     * damage. Applies the mutual `clinched` hold-link between attacker and
     * a single picked target via mechanics/holdLink.applyHoldLink. The
     * existing token-movement + incapacitation hooks auto-break the link.
     * Close Quarters bonus on follow-up strikes only fires when the
     * attacker is the bound partner. */
    clinch: Object.freeze({
        kind: "movement",
        labelKey: "WITCHER.CombatExtended.Action.Clinch",
        descKey:  "WITCHER.CombatExtended.Action.ClinchDesc",
        staCost: 0, meleeOnly: true, noDamage: true,
        appliesStatus: "clinched",
        /* Hint for the Move-menu UI: requires a single picked target. */
        requiresTarget: true
    }),
    charge: Object.freeze({
        kind: "attack",
        labelKey: "WITCHER.CombatExtended.Action.Charge",
        descKey:  "WITCHER.CombatExtended.Action.ChargeDesc",
        staCost: 1, toHit: -3, dmgMult: 2, attacks: 1, meleeOnly: true, fullRound: true
    }),
    grapple: Object.freeze({
        kind: "attack",
        labelKey: "WITCHER.CombatExtended.Action.Grapple",
        descKey:  "WITCHER.CombatExtended.Action.GrappleDesc",
        /* CE Grapple:
         *  - This is the MELEE (weapon) grapple, only offered on a weapon
         *    carrying the Grappling quality. Per the *** rule it rolls the
         *    WEAPON's own skill — NO firstRollSkill override. (The unarmed
         *    grapple lives in the brawl dialog and rolls Brawling there.)
         *  - Defender picks Brawling / Dodge Escape / Reposition — plus their
         *    OWN Grappling weapon if they have one (see defensePromptDialog
         *    `DEFENSE_GATE.grapple` + GRAPPLE_DEFENSE_KINDS).
         *  - On hit: target gets `grappled`, grappler gets `isGrappling`
         *    (visible only; the -2 penalty comes from the runtime
         *    carve-out in mechanics/holdModifiers).
         *  - Grappled target may spend their action for a Reverse
         *    Grapple — swaps holder/target on the pair. Handled by the
         *    `reverseGrapple` action below. */
        staCost: 1, toHit: 0, dmgMult: 1, attacks: 1, meleeOnly: true, noDamage: true,
        /* Only offered on a weapon that carries the Grappling quality — you
         * can't grapple with a plain sword (that's unarmed Brawling). */
        requiresQuality: "grappling",
        appliesStatus: "grappled"
    }),
    pommelStrike: Object.freeze({
        kind: "attack",
        labelKey: "WITCHER.CombatExtended.Action.Pommel",
        descKey:  "WITCHER.CombatExtended.Action.PommelDesc",
        staCost: 1, toHit: 0, dmgMult: 0.5, attacks: 1, meleeOnly: true, nonLethal: true
    }),
    bash: Object.freeze({
        kind: "attack",
        labelKey: "WITCHER.CombatExtended.Action.Bash",
        descKey:  "WITCHER.CombatExtended.Action.BashDesc",
        /* CE Bash (rework 2026-07-02): the attack roll is a Brawling
         * check, defender picks dodge or reposition. If the swing
         * lands, an opposed Physique-vs-Physique roll fires as a
         * post-hit rider — defender adds their equipped shield's Cover
         * Value to their Physique. On attacker win: push 1d3m directly
         * away from the attacker (walls clip via pushToken). On +7
         * delta: also apply Staggered. noDamage — the shove itself
         * doesn't deal HP; the push + stagger is the whole point. */
        staCost: 1, toHit: 0, dmgMult: 1, attacks: 1, meleeOnly: true,
        firstRollSkill: "brawling", noDamage: true, appliesBashRider: true
    }),
    push: Object.freeze({
        kind: "attack",
        labelKey: "WITCHER.CombatExtended.Action.Push",
        descKey:  "WITCHER.CombatExtended.Action.PushDesc",
        /* Push ⌊PHY/3⌋ metres (Physique base, rounded down) — NO damage. The
         * weapon roll is skipped (noDamage); a rider in weaponAttackMixin applies
         * the knockback on a hit. Only offered on a Grappling weapon (the *** rule
         * — a grapple weapon may perform brawling actions with its own skill);
         * unarmed Push lives in the brawl dialog. */
        staCost: 1, toHit: 0, dmgMult: 1, attacks: 1, meleeOnly: true, noDamage: true,
        requiresQuality: "grappling",
        /* Push is a grappler-only shove — only the holder of the grapple/pin
         * may shove their foe away (which breaks the hold). Gated like pin/choke
         * (holder holds THIS target); the grapplee can't push. */
        prereq: "grappling"
    }),
    slam: Object.freeze({
        kind: "attack",
        labelKey: "WITCHER.CombatExtended.Action.Slam",
        descKey:  "WITCHER.CombatExtended.Action.SlamDesc",
        /* Double KICK damage (not weapon damage — the *** rule swaps only the
         * skill) to a random location, knock prone, shove 1d6m back, and force
         * a Stun save. The weapon roll is skipped (noDamage); a rider in
         * weaponAttackMixin applies the whole effect on a hit. Grappler-only
         * (prereq grappling): only the holder may slam their held foe — the
         * grapplee can't. */
        /* −3 to hit — a standalone Slam penalty, NOT the strong-strike coupling. */
        staCost: 1, toHit: -3, dmgMult: 1, attacks: 1, meleeOnly: true, noDamage: true,
        requiresQuality: "grappling",
        prereq: "grappling"
    }),
    takedown: Object.freeze({
        kind: "attack",
        labelKey: "WITCHER.CombatExtended.Action.Takedown",
        descKey:  "WITCHER.CombatExtended.Action.TakedownDesc",
        /* NON-LETHAL punch damage (to stamina, still soaked by SP) + BOTH go
         * prone while the grapple is MAINTAINED. Weapon roll skipped (noDamage);
         * a rider in weaponAttackMixin applies the whole effect. Usable by EITHER
         * role in the grapple (prereq inGrappleWith). */
        staCost: 1, toHit: 0, dmgMult: 1, attacks: 1, meleeOnly: true, noDamage: true,
        requiresQuality: "grappling",
        prereq: "inGrappleWith"
    }),
    trip: Object.freeze({
        kind: "attack",
        labelKey: "WITCHER.CombatExtended.Action.Trip",
        descKey:  "WITCHER.CombatExtended.Action.TripDesc",
        /* Trip (grappler-only) — like Takedown but only the TARGET goes prone.
         * On a hit: NON-LETHAL punch (to stamina, soaked by SP) + the target
         * falls prone; the grappler stays up and the grapple is MAINTAINED.
         * Weapon roll skipped (noDamage); a rider in weaponAttackMixin applies
         * the whole effect. Grappler-only (prereq grappling); Grappling weapon
         * required in the melee dialog, same as Takedown. */
        staCost: 1, toHit: 0, dmgMult: 1, attacks: 1, meleeOnly: true, noDamage: true,
        requiresQuality: "grappling",
        prereq: "grappling"
    }),
    disarm: Object.freeze({
        kind: "attack",
        labelKey: "WITCHER.CombatExtended.Action.Disarm",
        descKey:  "WITCHER.CombatExtended.Action.DisarmDesc",
        /* Disarm — grapple action, made at −4. Punch damage to the weapon arm +
         * knock the weapon 1d6m random (or DC 18 Brawling to snatch it). Needs an
         * active grapple AND, with a weapon, the Grappling quality. Handler in
         * brawlMixin (unarmed) / the disarm scatter rider (weapon). */
        staCost: 1, toHit: -4, dmgMult: 1, attacks: 1, meleeOnly: true, noDamage: true,
        requiresQuality: "grappling", prereq: "grappling"
    }),
    meleeDisarm: Object.freeze({
        kind: "attack",
        labelKey: "WITCHER.CombatExtended.Action.MeleeDisarm",
        descKey:  "WITCHER.CombatExtended.Action.MeleeDisarmDesc",
        /* Melee Disarm — disarm with ANY melee weapon: no grapple, no special
         * quality, just −6. Knocks the target's weapon 1d6m random (scatter). You
         * canNOT snatch it for yourself. Handler: the disarm scatter rider. */
        staCost: 1, toHit: -6, dmgMult: 1, attacks: 1, meleeOnly: true, noDamage: true
    }),
    tackle: Object.freeze({
        kind: "attack",
        labelKey: "WITCHER.CombatExtended.Action.Tackle",
        descKey:  "WITCHER.CombatExtended.Action.TackleDesc",
        /* Tackle — full-round smash. Opposed PHYSIQUE (auto-rolled). Win → you
         * BOTH go prone; lose → only YOU. No weapon damage. Resolved by the tackle
         * branch in weaponAttackMixin (skips the weapon roll). */
        staCost: 1, toHit: 0, dmgMult: 1, attacks: 1, meleeOnly: true, noDamage: true, fullRound: true
    }),
    pin: Object.freeze({
        kind: "attack",
        labelKey: "WITCHER.CombatExtended.Action.Pin",
        descKey:  "WITCHER.CombatExtended.Action.PinDesc",
        /* Kick damage to the torso — not weapon damage. Chat-card rider
         * describes; weapon roll skipped. In CE, pinner also becomes
         * `isPinning` (visible + cannotMove: locked to target's space
         * until pin ends) and takes -3 to physical checks except vs
         * the pinned foe (runtime carve-out in holdModifiers). */
        staCost: 1, toHit: 0, dmgMult: 1, attacks: 1, meleeOnly: true, noDamage: true, prereq: "grappling",
        appliesStatus: "pinned"
    }),
    drag: Object.freeze({
        kind: "attack",
        labelKey: "WITCHER.CombatExtended.Action.Drag",
        descKey:  "WITCHER.CombatExtended.Action.DragDesc",
        /* Not a weapon strike — an opposed PHYSIQUE test (auto-rolled). Handled
         * by a weaponAttackMixin early branch that runs mechanics/drag.performDrag
         * and skips the weapon roll entirely. Usable by EITHER party in the grapple
         * (prereq inGrappleWith); needs the Grappling quality to appear in the
         * melee dialog (though the roll is Physique). */
        staCost: 1, toHit: 0, dmgMult: 1, attacks: 1, meleeOnly: true, noDamage: true,
        requiresQuality: "grappling",
        prereq: "inGrappleWith"
    }),
    chokehold: Object.freeze({
        kind: "attack",
        labelKey: "WITCHER.CombatExtended.Action.Chokehold",
        descKey:  "WITCHER.CombatExtended.Action.ChokeholdDesc",
        /* Suffocation damage = 3 + max(0, melee dmg mod), applied per
         * turn — not a weapon hit. Formula lives in the suffocation-
         * DoT path; catalog just marks the action. Rider note carries
         * the per-turn instruction. */
        /* Choke can only be applied to a foe you have PINNED (prereq "pinning").
         * With a WEAPON it needs the Strangling quality — NOT plain Grappling
         * (a grappling weapon can't choke). Unarmed Brawling always can. */
        staCost: 1, toHit: 0, dmgMult: 1, attacks: 1, meleeOnly: true, noDamage: true,
        requiresQuality: "strangling",
        prereq: "pinning",
        /* Target becomes `chokeheld`. Cleared when the pair is removed
         * (Escape action) or the holder is incapacitated. Pin + Choke
         * coexist by design — the same target can carry both statuses. */
        appliesStatus: "chokeheld"
    }),
    /* Reverse Grapple (2026-07-03 CE) — available to a grappled actor
     * when they are only grappled (no pin / choke on them). Opposed
     * Brawling vs the holder's Brawling. On win, swap holder/target on
     * the pair record and move the visible `isGrappling` stamp. Handler
     * in brawlMixin.brawlAttack routes on `kind: "reverseGrapple"`. */
    reverseGrapple: Object.freeze({
        kind: "attack",
        labelKey: "WITCHER.CombatExtended.Action.ReverseGrapple",
        descKey:  "WITCHER.CombatExtended.Action.ReverseGrappleDesc",
        staCost: 1, toHit: 0, dmgMult: 1, attacks: 1, meleeOnly: true, noDamage: true,
        /* NO firstRollSkill override: reversing WITH a weapon rolls that
         * weapon's own skill (the *** rule — a Grappling weapon's grapple
         * actions use the weapon skill, not Brawling). The unarmed reverse
         * goes through the brawl dialog, which rolls Brawling on its own. */
        prereq: "grappledSelfOnly",
        /* In the MELEE flow, reversing with a weapon needs the Grappling
         * quality (the *** rule: grapple actions can be done with a grappling
         * weapon's skill). Unarmed reverse is always available via the brawl
         * dialog, which doesn't gate on weapon quality. */
        requiresQuality: "grappling"
    }),
    /* Escape — RAW Core "Brawling & Wrestling": "Each turn, your opponent
     * can attempt a Dodge/Escape roll against your Brawling to slip
     * loose." Lives on the BRAWL side (BRAWL_ACTIONS.escape in
     * setup/config.mjs, handled in documents/mixins/brawlMixin.mjs) —
     * doesn't need a weapon, doesn't route through the strike table.
     * Users in CE mode reach it via the same brawl dialog that shows
     * Punch / Kick / Grapple etc. */
    /* ── Defenses ────────────────────────────────────────────────────── */
    parry: Object.freeze({
        kind: "defense",
        labelKey: "WITCHER.CombatExtended.Action.Parry",
        descKey:  "WITCHER.CombatExtended.Action.ParryDesc",
        staCost: 0, penalty: -3, defenseSkill: "weapon"
    }),
    block: Object.freeze({
        kind: "defense",
        labelKey: "WITCHER.CombatExtended.Action.Block",
        descKey:  "WITCHER.CombatExtended.Action.BlockDesc",
        staCost: 0, penalty: 0, defenseSkill: "weapon"
    }),
    dodge: Object.freeze({
        kind: "defense",
        labelKey: "WITCHER.CombatExtended.Action.Dodge",
        descKey:  "WITCHER.CombatExtended.Action.DodgeDesc",
        staCost: 1, penalty: 0, defenseSkill: "dodge"
    }),
    /* Internal key kept as `reposition` to avoid churning flags / socket
     * payloads. Display label is "Relocate" under Combat Extended (the
     * label flips through the labelKey i18n target). */
    reposition: Object.freeze({
        kind: "defense",
        labelKey: "WITCHER.CombatExtended.Action.Relocate",
        descKey:  "WITCHER.CombatExtended.Action.RelocateDesc",
        staCost: 2, penalty: 0, defenseSkill: "athletics"
    })
});

/* List of editable knobs per kind — drives the editor table columns AND
 * the override merge (only these fields are persisted). Anything not in
 * this list is read-only metadata and is taken straight from the default. */
export const EDITABLE_FIELDS = Object.freeze({
    attack:   Object.freeze(["label", "desc", "staCost", "toHit", "dmgMult", "attacks", "noDamage", "nonLethal", "fullRound"]),
    defense:  Object.freeze(["label", "desc", "staCost", "penalty"]),
    movement: Object.freeze(["label", "desc", "staCost"])
});

/* Merge override over defaults. Override map is `{ key: { field: value } }`;
 * field names mirror EDITABLE_FIELDS. Non-editable fields are taken from
 * the default unchanged. Unknown keys in the override (e.g. an action that
 * was renamed in code) are silently dropped — the editor lets the GM
 * resurface them by re-editing or via Reset. */
export function mergeCombatActions(defaults, override) {
    const out = {};
    const ov = override && typeof override === "object" ? override : {};
    for (const [key, def] of Object.entries(defaults)) {
        const o = ov[key] && typeof ov[key] === "object" ? ov[key] : null;
        if (!o) { out[key] = def; continue; }
        const merged = { ...def };
        const editable = EDITABLE_FIELDS[def.kind] ?? [];
        for (const f of editable) {
            if (!Object.hasOwn(o, f)) continue;
            const v = o[f];
            /* Special-case the two i18n-key fields: override stores LITERAL
             * label / description text, surfaced as `labelText` / `descText`
             * on the merged entry. Engine consumers prefer `labelText` over
             * `labelKey` when present, so the GM's edits appear directly
             * without needing an i18n hot-reload. */
            if (f === "label") { if (typeof v === "string" && v.length) merged.labelText = v; continue; }
            if (f === "desc")  { if (typeof v === "string" && v.length) merged.descText  = v; continue; }
            /* Booleans + numbers pass straight through (with a coerce so
             * an editor input "3" doesn't end up as a string). */
            if (typeof def[f] === "number" || ["staCost","toHit","dmgMult","attacks","penalty"].includes(f)) {
                const n = Number(v);
                if (Number.isFinite(n)) merged[f] = n;
            } else {
                merged[f] = Boolean(v);
            }
        }
        out[key] = Object.freeze(merged);
    }
    return Object.freeze(out);
}

/* Read the override setting + merge with defaults. Safe to call before
 * game.settings is ready — returns the bare defaults in that case (the
 * dock/dialog will re-resolve once the editor changes land). */
export function getActiveCombatActions() {
    try {
        const ov = game.settings?.get?.(SYSTEM_ID, "combatActionsOverride") ?? {};
        return mergeCombatActions(DEFAULT_COMBAT_ACTIONS, ov);
    } catch (_) {
        return DEFAULT_COMBAT_ACTIONS;
    }
}

/* Resolve the display label for an action entry — preferring the editor-
 * authored override text, falling back to the i18n key. Used everywhere
 * the user sees an action name (dialog button, chat card, dock tooltip). */
export function actionLabel(entry) {
    if (entry?.labelText) return String(entry.labelText);
    if (entry?.labelKey)  return game.i18n?.localize?.(entry.labelKey) ?? entry.labelKey;
    return "";
}

export function actionDescription(entry) {
    if (entry?.descText) return String(entry.descText);
    if (entry?.descKey)  return game.i18n?.localize?.(entry.descKey) ?? entry.descKey;
    return "";
}

/* Return the active attack-strike table the weapon-attack pipeline reads.
 *
 *   - When Combat Extended is OFF, returns the legacy `STRIKE_TYPES`
 *     verbatim — every existing call site keeps its keys ("normal",
 *     "strong", "fast", "joint", "charge", "pommel", "disarm", "trip",
 *     "feint") and its mechanics unchanged.
 *   - When ON, returns the CE attack actions reshaped into the strike-
 *     table contract the legacy consumers expect. CE keys are the new
 *     authoritative ones (single, strongAttack, fastAttack, …); fields
 *     are field-compatible with STRIKE_TYPES (labelKey, toHit, dmgMult,
 *     attacks, fullRound, meleeOnly, offhand, firstRollSkill, nonLethal,
 *     plus a `staCost` and `note` for the card rider).
 *
 * The legacy STRIKE_TYPES import is intentional — we read it at call time
 * so a GM toggle flip propagates without reload. Importing it eagerly
 * here would create a circular dep (config.mjs ↔ actions.mjs), so the
 * helper accepts the table as an argument from its caller (see
 * `getActiveStrikeTable(STRIKE_TYPES)` usage in attackDialog /
 * weaponAttackMixin). */
export function getActiveStrikeTable(legacyStrikeTypes) {
    /* Gated on the per-subsystem `actionCosts` toggle (which itself
     * requires the master extendedCombat toggle on). Falling back to
     * the legacy STRIKE_TYPES when either is off means GMs can keep
     * CE's guards / Raise Shield without overriding the strike costs. */
    let ceEnabled = false;
    try { ceEnabled = isCESubsystemEnabled("actionCosts"); }
    catch (_) { /* settings not ready — fall through to legacy */ }
    if (!ceEnabled) return legacyStrikeTypes;

    const ce = getActiveCombatActions();
    const out = {};
    for (const [key, entry] of Object.entries(ce)) {
        if (entry.kind !== "attack") continue;
        /* Reshape into the STRIKE_TYPES contract. Unknown CE fields (prereq,
         * requiresPiercing, requiresShield, defenseSkill) ride through as
         * extra props — the legacy consumers ignore them. The label-resolution
         * pipeline (actionLabel / actionDescription) still works because
         * labelKey + labelText are both present on the entry. */
        out[key] = {
            labelKey:        entry.labelKey,
            labelText:       entry.labelText ?? null,
            descKey:         entry.descKey,
            descText:        entry.descText ?? null,
            toHit:           Number(entry.toHit ?? 0),
            dmgMult:         Number(entry.dmgMult ?? 1),
            attacks:         Math.max(1, Number(entry.attacks ?? 1)),
            staCost:         Number(entry.staCost ?? 0),
            note:            entry.descKey,         // chat-card rider description
            meleeOnly:       !!entry.meleeOnly,
            offhand:         !!entry.offhand,
            firstRollSkill:  entry.firstRollSkill ?? null,
            noDamage:        !!entry.noDamage,
            nonLethal:       !!entry.nonLethal,
            fullRound:       !!entry.fullRound,
            /* `thrown: true` is what signals both the Throwing open-category
             * bonus (via ctx.isThrown) AND the post-attack drop-to-world
             * pipeline (_dropThrownWeapon). If the GM authors a custom
             * "throw" CE action, preserve this flag or the sword stays
             * glued to the hand and the bonus silently vanishes. */
            thrown:          !!entry.thrown,
            /* CE-only metadata — consumers that need it (the attack pipeline's
             * pre-req gating, quality-bonus resolver) read directly off the
             * CE table via getActiveCombatActions(). Surfaced here so any
             * future legacy-shaped consumer can read them too. */
            requiresPiercing: !!entry.requiresPiercing,
            requiresShield:   !!entry.requiresShield,
            prereq:           entry.prereq ?? "",
            /* Weapon-quality gate (e.g. Grapple only on a Grappling weapon)
             * and the hold/status a strike lands — the attackDialog picker
             * (passesQuality) and weaponAttackMixin (appliesStatus apply) read
             * these off the strike meta, so they MUST survive the reshape or
             * grapple shows on every weapon and does nothing on a hit. */
            requiresQuality:  entry.requiresQuality ?? null,
            appliesStatus:    entry.appliesStatus ?? null
        };
    }
    /* Fundamental strikes that CE doesn't redefine still need to be
     * available under CE. Throw is the canonical case — its `thrown: true`
     * flag drives both the Throwing OC bonus and the drop-to-world path.
     * If the CE action-costs table doesn't include a `throw` entry, splice
     * in the legacy one so those two flows keep working. Same principle
     * would apply to any future "always available regardless of ruleset"
     * strike; keep the list explicit. */
    for (const key of ["throw"]) {
        if (!out[key] && legacyStrikeTypes[key]) out[key] = legacyStrikeTypes[key];
    }
    return Object.freeze(out);
}
