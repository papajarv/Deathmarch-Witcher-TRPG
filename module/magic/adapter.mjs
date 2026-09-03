/**
 * The Foundry adapter — the only file in `module/magic/` that knows Foundry
 * exists.
 *
 * Everything else runs in plain node. That was not an accident of style: the
 * previous engine could only be exercised by launching a game and casting a
 * spell at a token, so it was exercised by hand, occasionally, and the failure
 * modes that reached the table were the ones nobody thought to try. The whole
 * frame, all 103 authored entries, and the entire canvas are covered by tests
 * because this seam exists.
 *
 * The method list is not invented here. It is the 48 methods the corpus
 * actually reaches for, recorded by casting every entry through a proxy — so
 * the interface is derived from the spells rather than written in advance and
 * half-abandoned, which is what happened last time.
 *
 * PERMISSIONS. Applying anything to an actor the caster does not own fails
 * outright on a player client. Every such write goes through the GM socket:
 * `emitApplyStatus`, `emitApplyDamage`, `emitApplyAuthoredEffects`,
 * `emitPushToken`. Nothing in this file calls `createEmbeddedDocuments` or
 * `update` on a foreign actor directly, and nothing should — a spell that
 * works for the GM and silently does nothing for a player is the single most
 * common shape of bug in a Foundry system.
 */

import {
    emitDrainPool, emitApplyStatus, emitApplyDamage, emitApplyAuthoredEffects,
    emitCreateConjured, emitRemoveConjured,
    emitPushToken, requestDefenseFromOwner, emitRemoveAuthoredEffects, emitHealActor
} from "../setup/socketHook.mjs";
import { extendedRoll } from "../rolls/extendedRoll.mjs";
/* The one hit-location table. A spell that lands on a head and a sword that
 * lands on a head read the same row. */
import { ATTACK_LOCATIONS, rollHitLocation } from "../setup/config.mjs";
import { castFormula } from "./castFormula.mjs";
import { registerClock, cancelClock, cancelClocksFor } from "./adapter.clocks.mjs";
import { endWhere, ENDS, endOnDispel } from "./lifetimes.mjs";
import { resolveStatus, counterTagOf } from "./statuses.mjs";
import { localiseChoice, forDisplay, inSentence } from "./choiceLabel.mjs";

import { SYSTEM_ID } from "./systemId.mjs";

/**
 * Build an adapter bound to one caster.
 *
 * `opts.item` is the castable; `opts.message` is the chat card the cast is
 * narrating into, when there is one. Both are optional so the adapter can be
 * built for an effect that is firing long after its cast — a zone catching a
 * latecomer, a shield bursting — where neither still exists.
 */
/**
 * Is this actor inside a live combat round right now?
 *
 * Vigor caps what a caster may spend ON MAGIC IN ONE ROUND. Rounds only exist
 * inside a started combat, so outside one there is nothing to accumulate
 * against and nothing to clear the counter — see `commitChaos`.
 */
function inCombatRound(a) {
    const combat = game.combats?.active;
    if (!combat?.started) return false;
    return !!combat.combatants?.some(c => c.actor?.id === a?.id);
}

export function foundryAdapter(actor, opts = {}) {
    /* `card` is a mutable holder filled by `cast.mjs` the moment the cast card
     * is posted — before the blocks run, so damage can name the message its
     * breakdown belongs in. */
    const { item = null, message = null, card = null } = opts;

    return {
        /* The template the caster aimed this cast, if any. Set by
         * `pickTargets` and read by `createZone`, so one aim serves both.
         * Lives on the adapter rather than in a module — an adapter is built
         * per cast, so it cannot leak into the next one. */
        lastPlacement: null,


        /* ── Reading the caster ───────────────────────────────────────────
         * Synchronous by contract: the frame reads these while deciding
         * whether a cast is even legal, before anything has been spent. */

        currentStamina: (a = actor) => Number(a?.system?.derivedStats?.sta?.value) || 0,
        currentHealth:  (a = actor) => Number(a?.system?.derivedStats?.hp?.value) || 0,
        vigorThreshold: (a = actor) => Number(a?.system?.derivedStats?.vigor) || 0,

        /* Adrenaline stamina is deliberately EXCLUDED from the vigor check —
         * the same ruling the old castSpellMixin carried, kept because the
         * alternative silently makes every adrenaline-fuelled cast an
         * over-exertion. */
        chaosSpentThisRound: (a = actor) => inCombatRound(a)
            ? Number(a?.getFlag?.(SYSTEM_ID, "chaosThisRound")) || 0
            : 0,

        skillValue: (a = actor, key = "spellcast") => skillTotal(a, key),

        /**
         * The bare RANK, without the governing stat.
         *
         * "5 ENC per 1 point of Spell Casting" and its kin mean the rank on the
         * sheet, and the only number the engine published was `skillTotal` —
         * rank + stat + modifiers, the number you roll with. Telekinesis
         * therefore told the table it could lift three times what the book
         * allows. Two different quantities that had one name between them.
         */
        skillRank: (a = actor, key = "spellcast") => {
            const name = SKILL_ALIASES[key] ?? key;
            for (const group of Object.values(a?.system?.skills ?? {})) {
                if (group && name in group) return Number(group[name]?.value) || 0;
            }
            return 0;
        },

        /* ── Who may contribute a defence ─────────────────────────────────
         * `contributors.mjs` asks these two questions and asks them with `?.`,
         * so while neither existed on this object both answered `undefined`
         * and every contributed defence was filtered out. Heliotrope and
         * Dispel-as-a-reaction are the ONLY defences against a spell whose
         * clause is `Defense: None` — forty-nine of the hundred and three
         * entries — so the effect was that half the book could not be
         * defended against at all. The unit tests stub both on their fake
         * adapters, which is exactly why they passed. */
        isWitcher: (a = actor) => isWitcher(a),

        /* Heliotrope is a SIGN, not a skill — there is no `heliotrope` key in
         * the system's skill map, so asking `skillValue(owner,"heliotrope")`
         * could only ever return 0. Knowing the sign is what qualifies you. */
        knowsSpell: (a = actor, name = "") => {
            const wanted = String(name).toLowerCase();
            return !!a?.items?.some?.(i =>
                ["spell", "hex", "ritual"].includes(i.type) &&
                String(i.name ?? "").toLowerCase() === wanted);
        },
        /* `.value`, not `.current` — the stat schema has never had `current`, so this
         * returned 0 for every stat. A `defence: {type:"stat"}` spell therefore set a
         * defence total of 0 and could not be resisted: Boiling Blood and Friend to
         * Wild Kind always hit. */
        statValue:  async (a = actor, stat = "will") => Number(a?.system?.stats?.[stat]?.value) || 0,

        casterElement: (a = actor) => a?.system?.magic?.element ?? "mixed",

        async distanceBetween(a = actor, b) {
            const from = tokenOf(a), to = tokenOf(b);
            if (!from || !to) return 0;
            return canvas.grid.measurePath([from.center, to.center]).distance;
        },

        async hasActiveInstance(a = actor, kind) {
            /* THIS SPELL, not this school.
             *
             * "You cannot cast Quen again until your current Quen shield has
             * been exhausted" locks one item. Matching on `magicKind` alone
             * would have refused every sign in the game the moment any one of
             * them was up — so the item is checked first and the kind only
             * where an effect predates the id being recorded. */
            const id = item?.id ?? null;
            return !!a?.effects?.some?.((e) => {
                if (e.disabled) return false;
                const flags = e.flags?.[SYSTEM_ID] ?? {};
                if (id && flags.sourceItemId) return flags.sourceItemId === id;
                return flags.magicKind === kind;
            });
        },

        /* ── Paying for it ───────────────────────────────────────────────── */

        /**
         * The system's own cast dialog — foci, glyphs, adrenaline, elements.
         *
         * `declareCast` was extracted from castSpellMixin so both engines open
         * the SAME dialog and read the same declaration. The prompts below are
         * the fallback for a spell whose frame the dialog cannot describe, and
         * for the test harness.
         */
        async declareCast(a = actor, frame, opts = {}) {
            if (!item || typeof a?.declareCast !== "function") return undefined;
            const skillKey = frame?.kind === "invocation" ? "spellcast" : "spellcast";
            return a.declareCast(item, {
                skillKey, isRitual: frame?.kind === "ritual",
                /* Whether a called shot is on offer, decided by the frame from
                 * where the template actually landed. */
                aimable: opts.aimable === true, reach: opts.reach ?? null,
                /* Everything else the tree says the dialog should offer. */
                facts: opts.facts ?? null
            });
        },

        /* Both prompts are built here rather than borrowed from castDialog.
         * They are pure translation — a number out of a person — and pointing
         * at helpers that did not exist is how the first version of this file
         * threw on every sign in the game. Anything the adapter imports has to
         * be something that is actually there. */
        async promptStamina(a = actor, cost) {
            const max = Math.min(cost.max ?? 7, this.currentStamina(a));
            if (max < (cost.min ?? 1)) return null;         // cannot afford the floor
            const picked = await numberPrompt({
                title: item?.name ?? game.i18n.localize("WITCHER.Magic.Cast"),
                label: game.i18n.format("WITCHER.Magic.SpendBetween",
                                        { min: cost.min ?? 1, max }),
                value: cost.min ?? 1, min: cost.min ?? 1, max
            });
            return picked;
        },

        async promptBand(a = actor, bands) {
            const affordable = Object.entries(bands)
                .filter(([n]) => Number(n) <= this.currentStamina(a));
            if (!affordable.length) return null;
            const { DialogV2 } = foundry.applications.api;
            const chosen = await DialogV2.prompt({
                window: { title: item?.name ?? "" },
                content: `<select name="b">${affordable.map(([n, label]) =>
                    `<option value="${n}">${n} STA — ${forDisplay(localiseChoice(label))}</option>`).join("")}</select>`,
                ok: { callback: (_e, b) => Number(b.form.elements.b.value) }
            }).catch(() => null);
            return Number.isFinite(chosen) ? chosen : null;
        },

        /* The Focus discount is law and applies automatically where legal —
         * floor of 1, in hand, one at a time, never witchers. The adapter owns
         * legality because it is the thing that can see the caster's gear. */
        async applyFocusDiscount(a = actor, cost) {
            if (isWitcher(a)) return cost;
            const focus = (a?.items ?? []).find(i =>
                /* `equipped`, not `isEquipped` — the latter is not a field on
                 * any item in this system (the base model declares `equipped`,
                 * and 38 other places read it). So this found nothing and the
                 * Focus discount never came off a single cast. */
                i.system?.equipped && (i.system?.qualities ?? []).includes("focus"));
            const relief = Math.max(0, Number(focus?.system?.qualityValues?.focus) || 0);
            return Math.max(1, cost - relief);
        },

        async spendStamina(a = actor, n) {
            if (!n) return;
            const sta = a.system.derivedStats.sta;
            await a.update({ "system.derivedStats.sta.value": Math.max(0, sta.value - n) });
        },

        async spendHealth(a = actor, n) {
            if (!n) return;
            const hp = a.system.derivedStats.hp;
            await a.update({ "system.derivedStats.hp.value": Math.max(0, hp.value - n) });
        },

        async commitChaos(a = actor, n) {
            /* Only inside a round. Outside combat the counter has nothing to
             * reset it, and a flag that only ever grows turns into a tax: cast
             * enough out of combat and every later cast overexerts, then the
             * vigor check refuses outright because the HP cost would kill you.
             * Found in a live world after roughly eight casts. */
            if (!inCombatRound(a)) return;
            const prior = Number(a.getFlag(SYSTEM_ID, "chaosThisRound")) || 0;
            await a.setFlag(SYSTEM_ID, "chaosThisRound", prior + n);
        },

        /* ── Targets ─────────────────────────────────────────────────────── */

        /**
         * Who the spell lands on.
         *
         * An AREA spell places a TEMPLATE and takes whoever is under it. That
         * was the hole: the frame carried the shape and the size, the panel
         * showed them, and nothing on the canvas ever drew one — you had to
         * click each victim by hand, for a cone. `pickAreaTargets` is the
         * system's existing aiming overlay and it already knows how to project
         * from the caster's token and harvest what it covers.
         *
         * A manual selection still wins. Someone who has targeted deliberately
         * means it, and an overlay that overrides them is an overlay they
         * learn to work around.
         */
        async pickTargets(a = actor, targeting) {
            if (targeting?.mode === "self") return [a];

            /* The SHAPE decides who is caught, so an area aims first and reads
             * the selection second. Checking `game.user.targets` before this
             * meant one targeted token skipped the template entirely. */
            if (targeting?.mode === "area") {
                const { pickAreaSnapshot, AREA_CANCELLED } = await import("../mechanics/castArea.mjs");
                /* SNAPSHOT, not just the tokens. It returns the geometry as
                 * well, and `createZone` reuses it — otherwise a spell that
                 * both hits an area and leaves a zone in it asks you to aim
                 * the same circle twice. Eight core spells do exactly that:
                 * Static Storm, Dormyn's Fog, Freya's Bravery and the rest. */
                const snap = await pickAreaSnapshot({
                    actor: a,
                    /* castArea reads shape and size off an ITEM; the frame is
                     * the authority here, so it is handed a shim carrying what
                     * the frame resolved rather than the raw sheet fields. */
                    item: { ...item, name: item?.name ?? "", system: { ...item?.system,
                        areaShape: targeting.shape, areaSize: targeting.size,
                        /* `!== false`, NOT `!!`. castArea's own rule is
                         * "exclude unless explicitly told otherwise", so an
                         * unset flag must stay unset-meaning-exclude. Coercing
                         * it with `!!` turned every spell that never mentions
                         * the caster into one that catches them: cast Aard,
                         * stagger yourself. Confirmed in a live world before
                         * this line changed. */
                        areaExcludeCaster: targeting.excludeCaster !== false } }
                });
                if (snap === AREA_CANCELLED) return null;        // they backed out
                if (!snap) return [];                            // no canvas, no tokens
                this.lastPlacement = snap.placement;
                /* An empty area is a real answer: the cone landed on nobody.
                 * That is a cast that happened and hit no one, not a cancel. */
                return (snap.actors ?? []).map(t => t.actor ?? t).filter(Boolean);
            }

            /* Everything else: a spell aimed at a person. Here the selection
             * IS the answer — you clicked them, you meant them. */
            const targeted = [...(game.user?.targets ?? [])].map(t => t.actor).filter(Boolean);
            if (targeted.length) return targeted;

            globalThis.ui?.notifications?.warn(game.i18n.localize("WITCHER.Magic.NoTargets"));
            return null;                              // null aborts; [] would cast at nobody
        },

        async nearestTargets(a = actor, { count, of, within }) {
            const origin = tokenOf(a);
            if (!origin) return [];
            const hostile = (t) => of !== "enemy" || t.document.disposition !== origin.document.disposition;
            return (canvas.tokens?.placeables ?? [])
                .filter(t => t.actor && t !== origin && hostile(t))
                .map(t => ({ t, d: canvas.grid.measurePath([origin.center, t.center]).distance }))
                .filter(x => within == null || x.d <= within)
                .sort((x, y) => x.d - y.d)
                .slice(0, count)
                .map(x => x.t.actor);
        },

        /* ── Rolling ─────────────────────────────────────────────────────── */

        async rollCast(a = actor, opts = {}) {
            /* The dialog's `grandMod` is the COMPLETE to-cast modifier — it is
             * built as `baseTotal + extraPenalty + otherMod + focus + glyph`,
             * and `baseTotal` is the caster's full skill total.
             *
             * This used to add `skillTotal` on top of it, so every authored
             * cast rolled the caster's skill TWICE. A WILL 8 / Spell Casting 8
             * mage saw "1d10 +16" in the dialog and then rolled 1d10+24. The
             * legacy path rolls `1d10 + grandMod` and was always right, which
             * is why only authored spells were inflated.
             *
             * `null` means nobody declared — a block rolling a bare extra
             * attack — and only then does the skill come from here. */
            const declared = opts.modifier != null;
            const base = declared ? Number(opts.modifier) || 0 : skillTotal(a, "spellcast");
            const formula = castFormula(base, opts.adrenalineDice);
            const roll = await extendedRoll(formula, {
                speaker: ChatMessage.getSpeaker({ actor: a }),
                flavor: item?.name ?? game.i18n.localize("WITCHER.Magic.Cast")
            }, { showResult: false });
            const natural = roll.terms?.[0]?.results?.[0]?.result ?? 0;
            return { total: roll.total, natural, fumbleBy: natural === 1 ? 1 : 0 };
        },

        async rollDefenceSkill(target, skill) {
            const roll = await extendedRoll(`1d10 + ${skillTotal(target, skill)}`, {
                speaker: ChatMessage.getSpeaker({ actor: target }),
                flavor: game.i18n.localize(`WITCHER.Defense.${skill}`)
            }, { showResult: false });
            return roll.total;
        },

        async rollFormula(formula) {
            if (typeof formula === "number") return formula;
            const roll = await new Roll(String(formula)).evaluate();
            return roll.total;
        },

        /**
         * Returns the ROLL, not just the verdict.
         *
         * A chance-gated effect looked identical to a guaranteed one on the
         * chat card — "Victim A is prone" whether that was certain or a one-in-
         * ten that happened to come up. The number is the interesting part, and
         * for a variable chance (`10*{sta}`) it is also the only way to see
         * what the spend actually bought.
         */
        /**
         * Roll a hit location off the system's own d10 table.
         *
         * A spell whose caster did not call a shot used to send the literal
         * string "random" as its location key. `resolveLocation` does not know
         * that word, falls back to the torso, and quietly applies a ×1
         * multiplier — so an unaimed spell always struck the chest and no
         * spell ever benefited from (or suffered) a rolled location, while a
         * weapon swing in the same world rolled one every time.
         */
        async rollLocation(kind = "human") {
            const { loc, face } = await rollHitLocation(kind);
            const def = ATTACK_LOCATIONS[loc];
            return { key: loc, face, mult: def?.mult ?? 1,
                     label: game.i18n.localize(def?.labelKey ?? loc) };
        },

        async rollPercentile(chance) {
            const pct = Math.round(Number(chance) || 0);
            if (pct >= 100) return { passed: true,  roll: null, chance: pct };
            if (pct <= 0)   return { passed: false, roll: null, chance: pct };
            const roll = await new Roll("1d100").evaluate();
            return { passed: roll.total <= pct, roll: roll.total, chance: pct };
        },

        /* The defender's own client answers, through the existing defence
         * request channel — so contributed defences (Heliotrope, Dispel) are
         * offered to the person who owns them rather than decided for them. */
        async requestDefence(target, { options, contributed, attackerRoll, record, bonus }) {
            const reply = await requestDefenseFromOwner({
                defenderActor: target,
                attackerName: actor?.name ?? "",
                weaponName: item?.name ?? "",
                weaponImg: item?.img ?? "",
                attackerUuid: actor?.uuid ?? "",
                allowedDefenses: dialogDefences(options),
                attackerDamageFlags: { magic: true, element: record?.element ?? null,
                                       defenceSet: record?.defenceSet ?? [], contributed, bonus }
            });
            return {
                option: reply?.itemId ?? null,
                total: reply?.defenseTotal ?? null,
                fumbled: !!reply?.fumbled
            };
        },

        /* A judgement, not a computation — "something the target would never
         * do" is the GM's call, so it is asked rather than derived. */
        async confirmCondition(target, { condition, bonus, item: source }) {
            const { DialogV2 } = foundry.applications.api;
            return DialogV2.confirm({
                window: { title: source?.name ?? "" },
                content: `<p>${game.i18n.format("WITCHER.Magic.ConfirmCondition", {
                    target: target?.name ?? "", condition, bonus })}</p>`
            });
        },

        async askDC(a = actor, { item: source }) {
            const { DialogV2 } = foundry.applications.api;
            const value = await DialogV2.prompt({
                window: { title: source?.name ?? "" },
                content: `<input type="number" name="dc" value="15">`,
                ok: { callback: (_e, b) => Number(b.form.elements.dc.value) }
            });
            return Number.isFinite(value) ? value : 15;
        },

        /* Magic fumbles in this system are ELEMENTAL — the school picks the
         * effect, and the result is narrative: the card names the rider for
         * the table to apply rather than auto-applying it. `by` is how far the
         * cast pushed past Vigor, and the over-exertion damage has already
         * been taken by the frame at 5 HP a point. */
        async applyFumble(a = actor, { band, by = 0, element }) {
            const { triggerElementalFumble } = await import("../chrome/chrome/fumble-dialog.js");
            return triggerElementalFumble(a, by, by * 5, element ?? null);
        },

        /* ── Writing to the world ─────────────────────────────────────────
         * Everything below this line may touch an actor the caster does not
         * own, so everything below this line goes through the GM. */

        async applyDamage(target, amount, { damageType, location, bypassArmour, nonLethal,
                                            bypassWorn, bypassNatural, bypassShield,
                                            qualities, critSeverity, channel, record }) {
            /* The result is now READ. `handleApplyDamage` has always returned
             * one and every caller threw it away, which is why
             * `core:ifPenetratedArmour` could never fire — Tryferi Gaeaf's
             * entire freeze rider was unreachable.
             *
             * Only the GM (and an owner) get an answer: for anyone else this
             * goes over a socket and returns nothing, so `penetrated` is null
             * — UNKNOWN, deliberately distinct from false. */
            /* The same three fields a weapon strike sends, for the same
             * reasons — this payload is read by ONE handler and one damage
             * calculator, and anything a spell leaves out is a rule that
             * silently stops applying to spells.
             *
             *   nonLethal     — the block has had this input since it was
             *                   written and it stopped here: `dealDamage`
             *                   set it, `intercept` forwarded it, and the
             *                   adapter did not destructure it. A subduing
             *                   spell drained HP like any other and ablated
             *                   the target's armour on the way through.
             *   locationLabel — the weapon card localizes it; without one the
             *                   handler falls back to the raw key, so a
             *                   breakdown read "leftLeg" under a spell and
             *                   "Left leg" under a sword.
             *   kind          — left at the handler's "weapon" default on
             *                   purpose: it is what gates Quen drain when no
             *                   defence list is sent, and the legacy spell
             *                   path (mechanics/castDamage.mjs) sends nothing
             *                   either. Spells drain Quen; changing that here
             *                   would change it for one engine only. */
            const key = location === "aimed" ? null : location;
            const locDef = key ? ATTACK_LOCATIONS[key] : null;
            const result = await emitApplyDamage({
                targetUuid: target?.uuid,
                amount,
                damageTypes: [damageType],
                locationKey: key,
                locationLabel: locDef ? game.i18n.localize(locDef.labelKey ?? key) : "",
                nonLethal: !!nonLethal,
                throughArmor: !!bypassArmour,
                bypassesWornArmor: !!bypassWorn,
                bypassesNaturalArmor: !!bypassNatural,
                bypassesShield: !!bypassShield,
                /* The pipeline turns these into armour-piercing, ablation and
                 * the on-hit rider set (bleeding, burning, freeze...) — all of
                 * it gated on the damage actually getting through, which is
                 * the part a plain `applyStatus` cannot express. */
                qualities: Array.isArray(qualities) ? qualities : [],
                critSeverity: critSeverity ?? null,
                sourceActorUuid: actor?.uuid ?? null,
                /* THE CARD THIS BELONGS TO.
                 *
                 * Without it the handler takes its "no attack message" branch
                 * and posts a standalone breakdown spoken by the VICTIM — one
                 * per damage application, so a multi-spike spell produced a
                 * column of orphan messages, none naming the spell, all ahead
                 * of the cast card in the log. With it, the breakdown, the SP
                 * chip and the "Quen soaked 5" line fold into the cast card
                 * exactly as they do for a sword.
                 *
                 * It also restores the fallback authorisation the weapon path
                 * has: a player whose GM hides NPC sheets owns their own cast
                 * card, and `isLegitimateAttackDamage` accepts that where a
                 * bare OBSERVER check refuses. */
                attackMessageUuid: card?.uuid ?? null,
                /* Which block did it, when a spell has several. */
                sourceLabel: item?.name ?? null,
                /* An ongoing tick is not a fresh attack: RAW, a condition that
                 * burns you every round does not get to drain your Quen again
                 * each time. The block's `channel` is exactly this axis. */
                isOngoingTick: channel != null && channel !== "attack",
                /* Incorporeal magic passes through an Active Shield. The item
                 * has said so since long before this engine; nothing forwarded
                 * it. */
                tangible: item?.system?.tangible !== false,
                magic: { channel, element: record?.element ?? null, casterRoll: record?.casterRoll ?? null }
            });
            if (!result) return { penetrated: null, finalDamage: null };
            return {
                finalDamage: result.finalDamage ?? null,
                /* "If they do damage through armor" — which is damage that
                 * REACHES HP, not damage that chipped a plate.
                 *
                 * The calculator's own `onPenetrate` rider fires only when the
                 * SP stage ablated, so an unarmoured target never produced it
                 * and a spike through bare skin counted as stopped. Final
                 * damage above zero is the condition the book is describing,
                 * and it is right in both cases; the rider is kept as a
                 * stronger signal where armour was actually involved. */
                penetrated: (result.finalDamage ?? 0) > 0
                         || (result.effects ?? []).some(e => e.kind === "onPenetrate")
            };
        },

        /* Through the alias table: the corpus says `onFire`, the system
         * registers `burning`, and an unrecognised id is DROPPED SILENTLY by
         * the GM handler — which is how Igni could have shipped never once
         * setting anything alight. */
        /**
         * Returns whether the status was actually applied.
         *
         * The GM handler DROPS an id it does not recognise, with a console
         * warning nobody reads — and the block pushed to `ctx.created`
         * regardless, so the chat card announced "Victim A is bleeding" for a
         * status that was never applied. A card that reports what a block
         * INTENDED rather than what happened is worse than no card: it is the
         * one place at the table where the truth is supposed to be.
         *
         * Checked here rather than in the block because the alias table lives
         * here — `onFire` really does become `burning`, and only the resolved
         * id can be compared against what the world registers.
         */
        async applyStatus(target, statusId, { record } = {}) {
            const id = resolveStatus(statusId);
            const known = (CONFIG.statusEffects ?? []).some(s => s.id === id);
            if (!known) {
                console.warn(`${SYSTEM_ID} | ${item?.name ?? "a spell"} applies "${statusId}"${
                    id === statusId ? "" : ` (resolved to "${id}")`}, which this world does not register`);
                globalThis.ui?.notifications?.warn(game.i18n.format("WITCHER.Magic.NoSuchStatus",
                    { status: statusId, item: item?.name ?? "" }));
                return false;
            }
            /* Suppressed? Then it does not land. Downpour "counteracts fire
             * effects", and until this the fire it was counteracting caught
             * anyway. */
            const stopped = this.suppressing?.(target, counterTagOf(id), record?.casterRoll ?? null);
            if (stopped) {
                globalThis.ui?.notifications?.info(game.i18n.format("WITCHER.Magic.Suppressed",
                    { status: id, tag: stopped.tag, target: target?.name ?? "" }));
                return false;
            }
            emitApplyStatus({
                targetUuid: target?.uuid, statusId: id, action: "add",
                sourceActorUuid: actor?.uuid ?? null,
                flags: magicFlags(record, item)
            });
            return true;
        },

        async removeStatus(target, statusId) {
            /* ONE REMOVAL AT A TIME PER ACTOR AND STATUS.
             *
             * Foundry keeps a single ActiveEffect per status id, but a spell
             * can create many LIFETIMES pointing at it — Tryferi Gaeaf's eight
             * spikes each freeze the same victim, so eight lifetimes end at
             * once. Each fired its own removal, all eight resolved the same
             * document id, one won and the other seven came back
             * `ActiveEffect "..." does not exist!` from the server. That
             * throw aborts the rest of ITS batch, so a second status could
             * survive a strip that should have cleared it — which is exactly
             * the race the zone layer already guards against with its
             * STRIPPING set (mechanics/zoneEffects.mjs).
             *
             * Live, Yrden logged six of them in one cast. */
            const id = resolveStatus(statusId);
            const key = `${target?.uuid ?? "?"}:${id}`;
            if (REMOVING.has(key)) return REMOVING.get(key);
            const job = (async () => {
                try {
                    return await emitApplyStatus({ targetUuid: target?.uuid, statusId: id,
                        action: "remove", sourceActorUuid: actor?.uuid ?? null });
                } finally { REMOVING.delete(key); }
            })();
            REMOVING.set(key, job);
            return job;
        },

        async heal(target, amount) {
            /* Healing a foreign actor is the same permission problem as
             * hurting one — but NOT the same pipeline. Negative damage was
             * clamped away by the damage calculator, which knows nothing about
             * a "healing" type, so this had never restored a hit point. */
            emitHealActor({ targetUuid: target?.uuid, amount: Math.abs(amount) });
        },

        async drainResource(target, resource, amount, { record } = {}) {
            /* A DRAIN IS A SUBTRACTION, not a modifier.
             *
             * This wrote an ActiveEffect with `mode: 2, value: -amount` on the
             * pool — a live-computed penalty sitting on a number the actor
             * also spends from, with no lifetime attached. Anialwch's "lowers
             * the target's CURRENT Stamina by 4d6" became a permanent −17 that
             * moved with the pool instead of a one-time loss of 17, and any
             * later recalculation re-applied it.
             *
             * Taken off the pool directly, through the GM so it works on an
             * actor the caster does not own. */
            const n = Math.max(0, Math.floor(Number(amount) || 0));
            if (!n) return;
            const path = statPath(resource, target) ?? `system.derivedStats.${resource}.value`;

            /* Health is damage, and damage has a pipeline — armour, resists,
             * shields and the breakdown card all belong to it. */
            if (path === "system.derivedStats.hp.value") {
                await emitApplyDamage({ targetUuid: target?.uuid, amount: n,
                    damageTypes: [], locationKey: "torso", throughArmor: true,
                    sourceActorUuid: actor?.uuid ?? null,
                    attackMessageUuid: card?.uuid ?? null, sourceLabel: item?.name ?? null });
                return;
            }
            /* Stamina and the pools: a plain subtraction, floored at zero. */
            await emitDrainPool({ targetUuid: target?.uuid, path, amount: n,
                                  sourceActorUuid: actor?.uuid ?? null });
            void record;
        },

        async grantModifier(target, { stat, delta, op, scope, record }) {
            /* Resolved against the TARGET, because a skill's path depends on
             * which stat group holds it, and that is per-actor data. */
            const key = statPath(stat, target);
            if (!key) {
                /* Silence here is how "+3 Wilderness Survival" became nothing at
                 * all for months. If the sheet has no such field, say so. */
                console.warn(`${SYSTEM_ID} | ${item?.name ?? "a spell"} modifies "${stat}", which ${target?.name ?? "the target"} has no field for`);
                globalThis.ui?.notifications?.warn(game.i18n.format("WITCHER.Magic.NoSuchStat",
                    { stat, target: target?.name ?? "" }));
                return null;
            }
            const payload = effectPayload({
                name: item?.name ?? "Modifier",
                changes: [{ key, value: String(delta),
                            mode: op === "multiply" ? 1 : op === "set" ? 5 : 2 }],
                record, item, extra: { scope }
            });
            emitApplyAuthoredEffects({ targetUuid: target?.uuid, payloads: [payload] });
            return { name: payload.name, stat, castId: record?.castId ?? null };
        },

        async removeModifier(target, ref) {
            /* Through the GM, like every other write to somebody else's actor.
             * This used to be `if (effect?.isOwner) effect.delete()`, so a
             * modifier placed on an actor the caster does not own applied
             * (that half went through the GM) and then never lifted. Yrden's
             * SPD penalty was permanent on anything a player did not own. */
            emitRemoveAuthoredEffects({
                targetUuid: target?.uuid,
                match: { name: ref?.name, castId: ref?.castId ?? undefined }
            });
        },

        /**
         * A granted pool — extra Luck, extra Stamina, a reserve to spend down.
         *
         * It used to write `system.pools.<resource>`, and there is no `pools`
         * store on the actor: the effect was created, sat on the sheet, and
         * granted nothing. Blessing of Fortune and Luck of the Father handed
         * out an empty promise.
         *
         * Routed through the same `statPath` every other grant uses, so
         * `luck` lands on the luck stat and `sta`/`hp` on their derived
         * fields — and a resource with nowhere to go says so instead of
         * writing into the void.
         */
        async grantPool(target, { resource, size, record }) {
            const key = statPath(resource, target);
            if (!key) {
                console.warn(`${SYSTEM_ID} | ${item?.name ?? "a spell"} grants "${resource}", which ${
                    target?.name ?? "the target"} has no field for`);
                globalThis.ui?.notifications?.warn(game.i18n.format("WITCHER.Magic.NoSuchStat",
                    { stat: resource, target: target?.name ?? "" }));
                return null;
            }
            emitApplyAuthoredEffects({
                targetUuid: target?.uuid,
                payloads: [effectPayload({
                    name: item?.name ?? "Pool",
                    changes: [{ key, mode: 2, value: String(size) }],
                    record, item
                })]
            });
            return { resource, key };
        },

        async removePool(ref) { /* pools expire with their effect */ },

        async knockback(target, { metres, onImpact, record }) {
            const origin = tokenOf(actor), moved = tokenOf(target);
            if (!moved) return { struck: false };
            /* AWAITED, and its answer used.
             *
             * This fired the push and returned a hardcoded `struck: false`, so
             * `onImpact: "ramming"` — the default on the block, and the rule
             * every knockback spell in the book carries ("if they strike
             * something they take ramming damage") — could never fire. The
             * push handler already computes whether they hit a wall; it was
             * being thrown away one line after it arrived. */
            const push = await emitPushToken({
                tokenUuid: moved.document.uuid,
                sourcePoint: origin?.center ?? moved.center,
                distanceMeters: metres
            });
            /* Over a socket a player gets no answer back — UNKNOWN, which is
             * not the same as "they hit nothing". Only the GM's client can
             * resolve the impact, and it is the one that applies the damage. */
            if (!push) return { struck: null, moved: null };
            const struck = !!push.hitWall;

            /* RAMMING: the same rule a shove into a wall uses in melee — the
             * brawl path rolls it and sends a payload that bypasses worn and
             * natural armour. A spell that throws somebody into a wall does
             * the same thing to them as a shoulder that does. */
            if (struck && onImpact === "ramming") {
                const roll = await new Roll("1d6").evaluate();
                await emitApplyDamage({
                    targetUuid: target?.uuid,
                    weaponDamage: Math.max(0, Number(roll.total) || 0),
                    damageTypes: ["bludgeoning"],
                    locationKey: "torso",
                    locationLabel: game.i18n.localize(ATTACK_LOCATIONS.torso?.labelKey ?? "torso"),
                    bypassesWornArmor: true, bypassesNaturalArmor: true,
                    sourceActorUuid: actor?.uuid ?? null,
                    sourceLabel: game.i18n.localize("WITCHER.Magic.Ramming")
                });
            }
            /* `prone` is the other rule the dropdown offers, and it was equally
             * inert: the word was accepted and nothing was applied. */
            if (struck && onImpact === "prone") {
                await this.applyStatus?.(target, "prone", { record });
            }
            return { struck, moved: push.moved ?? null };
        },

        /* ── Persistent things ───────────────────────────────────────────── */

        /**
         * A zone that stays on the map.
         *
         * If the frame already had you aim a template to work out who was
         * caught, that same placement is reused. The alternative — which is
         * what happened before — was two aiming steps for one circle: one to
         * pick targets, one to leave the zone, in the same place, for eight of
         * the core spells.
         *
         * A block that names its own anchor still wins: Elgan's Theory
         * magnetises an OBJECT and its zone follows that, not wherever the
         * caster pointed. */
        async createZone(a = actor, spec) {
            const { createZoneTemplate } = await import("../mechanics/zoneEffects.mjs");

            /* `createZoneTemplate` needs WHERE — x, y and a direction. The
             * placement the frame already aimed has them; the block's own spec
             * has only a shape and a size, because a block describes a
             * footprint and not a position.
             *
             * So a spell that leaves a zone without hitting an area first —
             * Yrden, Ice Slick, Air Pocket, Elgan's Theory — has nowhere to
             * put it, and handed the template layer `x: undefined`. Those are
             * exactly the spells whose whole purpose is the zone. They aim it
             * now. */
            let placement = spec.anchor !== "object" && this.lastPlacement
                ? { ...this.lastPlacement, size: spec.size ?? this.lastPlacement.size }
                : null;

            /* AN OBJECT-ANCHORED ZONE SITS ON THE OBJECT.
             *
             * `anchor: "object"` was excluded from both the reuse and the
             * aiming path, so it fell through with no x/y at all and the
             * template layer's `Number(placement.x) || 0` built the zone at
             * scene coordinate (0,0) — the top-left corner of the map. Elgan's
             * Theory magnetised a patch of empty ground in the corner while
             * the card announced a region around the target.
             *
             * The object is whatever the spell was aimed at: the target's
             * token if it has one, else the caster's. */
            if (!placement && spec.anchor === "object") {
                const anchorTok = tokenOf(spec.on ?? null) ?? tokenOf(a);
                if (anchorTok) {
                    placement = { x: anchorTok.center.x, y: anchorTok.center.y,
                                  direction: 0, shape: spec.shape, size: spec.size };
                }
            }

            if (!placement && spec.anchor !== "object") {
                const { pickAreaSnapshot, AREA_CANCELLED } = await import("../mechanics/castArea.mjs");
                const snap = await pickAreaSnapshot({
                    actor: a,
                    item: { ...item, name: item?.name ?? "", system: { ...item?.system,
                        areaShape: spec.shape, areaSize: spec.size,
                        /* A zone anchored to the caster follows their token;
                         * anything else is placed where they click. */
                        areaAnchor: spec.anchor === "caster" ? "caster" : "free" } }
                });
                if (snap === AREA_CANCELLED || !snap) return null;
                placement = snap.placement;
                this.lastPlacement = placement;   /* a second zone reuses it */
            }

            const region = await createZoneTemplate({
                actor: a, item,
                placement: placement ?? spec,
                /* `onEnter` is deliberately NOT passed down here any more. It
                 * is a closure, `castContext` is written to the region's
                 * flags, and a function does not survive that — it arrived as
                 * undefined and the body never ran. It goes in a live registry
                 * instead, keyed by the region that was actually created. */
                castContext: { record: spec.record },
                staSpent: spec.record?.staSpent ?? 0, message,
                /* Handed DOWN, not registered up here afterwards. The zone's
                 * "who is already standing inside" sweep runs before this call
                 * returns, so a body registered on the next line was invisible
                 * to it: Curse of Sedna's whirlpool appeared under two people
                 * and contested neither, and Stammelford's Earthquake shook a
                 * 10m circle without touching anyone in it. */
                zoneBody: { onEnter: spec.onEnter }
            });
            return region;
        },

        async removeZone(zone) {
            /* Through the zone layer's own deleter, not `zone.delete()`.
             *
             * `createZoneTemplate` returns a RegionDocument, and this used to
             * call `zone?.template?.delete?.()` — a RegionDocument has no
             * `.template`, so the optional chain swallowed it and NO zone was
             * ever removed when its lifetime ran out. Calling `delete()`
             * directly fixed that and introduced a worse one: this lifetime and
             * the zone layer's own `roundsRemaining` countdown both end the
             * same region, and `deleteZoneRegion` owns the in-flight guard that
             * keeps the two from tearing down one RegionMesh twice. */
            const { clearZoneBody, deleteZoneRegion } = await import("../mechanics/zoneEffects.mjs");
            clearZoneBody(zone?.uuid);
            if (zone?.id) await deleteZoneRegion(zone);
        },

        /* A conjured thing with its own hit points — Earthen Spike's
         * stalagmite, Talfryn's roots, Rhwystr Graig's 30-SP wall.
         *
         * There is no token-spawning path in the system yet, so this posts the
         * object as a card the GM places, and SAYS so. A silent no-op would be
         * worse than an honest one: "20 points of damage breaks it" is a rule
         * somebody at the table has to be able to act on, and an object that
         * exists only in the engine's memory is one nobody can hit. */
        async createObject(a = actor, { what, hp, sp, size, blocksMovement, record }) {
            const label = game.i18n.localize(`WITCHER.Magic.Object.${what}`);
            /* IT GOES ON THE MAP.
             *
             * This posted a card saying "the GM places it" and returned
             * `placed: false`, so every conjuring spell in the book printed a
             * destructible HP total for something that did not exist —
             * "destroyed by doing 20 points of damage to it" with nothing on
             * the canvas to aim at, and `untilDestroyed` with nothing that
             * could ever fire it.
             *
             * Placed where the caster aimed, or at their feet when the spell
             * had nothing to aim (a wall you raise beside you). */
            const at = this.lastPlacement ?? tokenOf(a)?.center ?? null;
            const made = at ? emitCreateConjured({
                name: label, img: item?.img ?? null,
                /* No printed hit points means armour and nothing else — a
                 * 30 SP wall the book never gave a pool to. It still takes a
                 * token so it can be seen and stand in the way; it simply
                 * cannot be chipped down, which is what the book says. */
                hp: hp == null ? null : hp,
                sp, size, blocksMovement,
                sceneId: canvas?.scene?.id ?? null,
                x: at.x, y: at.y,
                /* Hostile so it reads as an obstacle and can be targeted; a
                 * wall is nobody's ally. */
                disposition: -1,
                castId: record?.castId ?? null,
                sourceActorUuid: a?.uuid ?? null
            }) : null;
            const ref = await made;

            await ChatMessage.create({
                content: `<p><strong>${label}</strong> — ${
                    [hp ? `${hp} HP` : null, sp ? `${sp} SP` : null, size].filter(Boolean).join(" · ")
                }</p>` + (ref ? "" : `<p class="witcher-narrate">${
                    game.i18n.localize("WITCHER.Magic.PlaceObject")}</p>`),
                speaker: ChatMessage.getSpeaker({ actor: a }),
                flags: magicFlags(record, item)
            });
            return { what, hp, sp, size, blocksMovement,
                     placed: !!ref, actorUuid: ref?.actorUuid ?? null,
                     tokenUuid: ref?.tokenUuid ?? null };
        },


        async removeObject(obj) {
            /* The whole thing — token and the actor behind it. This called
             * `obj?.token?.delete?.()` on a plain object that had neither. */
            if (obj?.actorUuid) emitRemoveConjured({ actorUuid: obj.actorUuid });
        },

        /* The pool lives on a flag rather than as an ActiveEffect: the shield
         * is the caster's own, so no permission hop is needed, and the damage
         * interception reads it before armour on every incoming hit. */
        async createShield(a = actor, { hp, charges, absorbs, record }) {
            /* THE POOL LIVES WHERE THE REST OF THE SYSTEM LOOKS FOR IT.
             *
             * This used to write one flag, `magicShield`, and nothing in the
             * codebase read it — not the damage handler, not the calculator,
             * not the sheet. So a Quen raised by this engine absorbed authored
             * spell damage (which routes through the engine's own interception
             * bus) and absorbed NOTHING from a sword, a bolt, a bomb, a claw or
             * a legacy-engine spell, while the cast card announced "a shield of
             * 15". A card that promises protection the world never received is
             * the worst thing this engine can do: a player reads it and
             * declines to dodge.
             *
             * The pipeline reads two things — `system.derivedStats.shield` (the
             * pool the calculator drains, `socketHook.mjs` stage 1) and a
             * `castShield`-flagged ActiveEffect (the badge it names and syncs).
             * Both are written here now, in the same shape the legacy engine
             * uses (`castSpellMixin.mjs`), so one Quen is one pool however it
             * was cast.
             *
             * Take-higher on both, because casting a smaller Quen must not chop
             * a bigger one — the same rule the legacy path applies. */
            const grant   = Math.max(0, Math.floor(Number(hp) || 0));
            const nCharges = Math.max(0, Math.floor(Number(charges) || 0));

            /* A WARD COUNTED IN CHARGES IS STILL A WARD, AND IT HAS TO SHOW.
             *
             * Demetia's Crest Surge turns aside "a number of water spells equal
             * to 2 times your Spell Casting skill value" — no hit points
             * anywhere in it, so it is authored `pool: "0"` and every charge
             * ward fell straight out of this method on the `grant <= 0` line
             * below. `consumeCharge` still worked, because `createShield`'s
             * block sets `state.charges` itself — so the mechanic ran off an
             * in-memory number on a bus subscription with nothing on the sheet,
             * no way for the caster to see how many blocks were left, and
             * nothing at all after a reload. Exactly the state the HP pool was
             * in before it was moved onto `derivedStats.shield` and a badge.
             *
             * It gets its own badge rather than sharing the `castShield` one:
             * the HP badge is tied to `derivedStats.shield` by two hooks in
             * `setup/hooks.mjs` that zero the pool when it is deleted, and a
             * charge ward has no pool for them to zero. Keyed by source item,
             * so a caster may hold a Quen and a Crest at once. */
            if (grant <= 0 && nCharges > 0) {
                return writeWardCharges(a, nCharges, {
                    itemId: item?.id ?? null, wardName: item?.name ?? null,
                    img: item?.img ?? null, absorbs, record, mode: "raise"
                });
            }
            if (grant <= 0) return null;

            const existing = a.effects?.find?.(e => !!e.flags?.[SYSTEM_ID]?.castShield) ?? null;
            const oldHp = Number(existing?.flags?.[SYSTEM_ID]?.activeShieldHp) || 0;
            const newHp = Math.max(oldHp, grant);

            const payload = {
                activeShieldHp: newHp,
                castShield:     true,
                /* What KIND of magic raised it, and which ITEM did.
                 *
                 * `hasActiveInstance` matches the `magicKind` flag, and this
                 * badge carried none — so Quen's "you cannot cast it again
                 * until the shield is exhausted" could not see the shield it
                 * was meant to be looking at. The item id is here for the same
                 * check: the book locks the SPELL, not the whole school, and a
                 * lock keyed on "sign" would refuse all ten of them. */
                magicKind:      record?.kind ?? item?.type ?? null,
                sourceItemId:   item?.id ?? null,
                sourceItem:     item?.uuid ?? null,
                sourceCaster:   a?.uuid ?? null,
                /* The engine's own two knobs ride along on the same badge
                 * rather than in a second flag nobody reads. */
                charges, absorbs,
                casterRoll: record?.casterRoll ?? null
            };
            try {
                if (existing) {
                    await existing.update({ [`flags.${SYSTEM_ID}`]: payload, name: item?.name ?? existing.name });
                } else {
                    await a.createEmbeddedDocuments("ActiveEffect", [{
                        name: item?.name ?? game.i18n.localize("WITCHER.Magic.Shield"),
                        img: item?.img ?? "icons/svg/shield.svg",
                        origin: a.uuid, transfer: false, statuses: [],
                        flags: { [SYSTEM_ID]: payload }
                    }]);
                }
                const cur = Number(a.system?.derivedStats?.shield) || 0;
                if (newHp > cur) await a.update({ "system.derivedStats.shield": newHp });
            } catch (err) {
                console.warn(`${SYSTEM_ID} | shield apply failed`, err);
            }
            return { hp: newHp };
        },

        /** The live pool, read from the one place everything drains. */
        shieldPool(a = actor) {
            return Math.max(0, Number(a.system?.derivedStats?.shield) || 0);
        },

        /**
         * Write the pool back after the engine's own ward absorbed some.
         *
         * Needed because the pool is now shared: the interception bus drains
         * it on the way in (Quen absorbs BEFORE armour) and the damage
         * calculator drains whatever is left on the way through. Without the
         * write-back the calculator would see the pre-absorption number and
         * soak the same points twice.
         */
        async setShieldPool(a = actor, n) {
            const next = Math.max(0, Math.floor(Number(n) || 0));
            try {
                await a.update({ "system.derivedStats.shield": next });
                if (next <= 0) {
                    /* The badge goes when the pool does — `setup/hooks.mjs`
                     * does the same for a shield emptied by the calculator. */
                    const badge = a.effects?.filter?.(e => !!e.flags?.[SYSTEM_ID]?.castShield) ?? [];
                    for (const e of badge) { try { await e.delete(); } catch (_) {} }
                }
            } catch (err) {
                console.warn(`${SYSTEM_ID} | shield drain failed`, err);
            }
        },

        /** Charges left on a charge-counted ward, read from the badge — the
         *  one place that survives a re-render, the way `shieldPool` reads the
         *  HP pool from the stat everything drains. */
        wardCharges(a = actor, itemId = null) {
            return wardChargesOf(a, itemId);
        },

        /**
         * Write a charge ward's remaining count back to its badge.
         *
         * The counterpart of `setShieldPool`, and needed for the same reason:
         * the count is shown to a player, so the number on the sheet has to be
         * the number the block is working from. At zero the badge goes, which
         * is what "until its charges run out" looks like on the character.
         *
         * Never names the ward from this adapter's `item` — during an
         * interception the adapter belongs to the INCOMING cast, so `item` is
         * the attacker's spell. The ward's own name rides on its badge.
         */
        async setWardCharges(a = actor, n = 0, { itemId = null } = {}) {
            return writeWardCharges(a, n, { itemId, mode: "set" });
        },

        /* Afan's Mirror's duplicates, Shape Nature's golem, Illusion's image.
         * Same honesty as `createObject`: announced for the GM to place, and
         * the card says whether the thing can be touched, because that is the
         * only mechanical difference between an illusion and a golem. */
        async summonCopies(a = actor, { count, what, tangible, controlled, record }) {
            const label = game.i18n.localize(`WITCHER.Magic.Summon.${what}`);
            const n = Math.max(0, Math.floor(Number(count) || 0));
            /* THEY GO ON THE MAP TOO — see `createObject`.
             *
             * A tree golem that "can be touched and can act", and illusory
             * copies of yourself that an enemy has to pick between, are both
             * things the table needs to SEE. This posted a card and returned
             * `placed: false`, so a summoned ally could not be targeted,
             * attacked, or moved, and `removeSummon` called `.delete()` on a
             * plain object — a no-op, so they never went away either.
             *
             * Intangible copies are placed as well: an illusion you cannot
             * distinguish from the caster is the entire point of the spell,
             * and it can be attacked (and dispelled by being hit).
             */
            const origin = tokenOf(a);
            const gs = canvas?.grid?.size ?? 100;
            const made = [];
            for (let i = 0; i < n && origin; i++) {
                /* Ringed around the caster so they do not stack on one square. */
                const angle = (i / Math.max(1, n)) * Math.PI * 2;
                const ref = await emitCreateConjured({
                    name: label, img: item?.img ?? a?.img ?? null,
                    /* A copy is as fragile as the book says it is: these have
                     * no printed hit points, so one point ends one. */
                    hp: 1, sp: 0, size: 1,
                    sceneId: canvas?.scene?.id ?? null,
                    x: origin.center.x + Math.cos(angle) * gs * 1.5,
                    y: origin.center.y + Math.sin(angle) * gs * 1.5,
                    /* A summon of yours is friendly; an illusion of you reads
                     * the same way to anyone looking at it. */
                    disposition: 1,
                    castId: record?.castId ?? null,
                    sourceActorUuid: a?.uuid ?? null
                });
                if (ref) made.push(ref);
            }
            await ChatMessage.create({
                content: `<p><strong>${n} × ${label}</strong></p><p>${
                    game.i18n.localize(tangible ? "WITCHER.Magic.Tangible" : "WITCHER.Magic.Intangible")
                }</p>`,
                speaker: ChatMessage.getSpeaker({ actor: a }),
                flags: magicFlags(record, item)
            });
            void controlled;
            return { what, count: n, tangible, placed: made.length > 0, made };
        },


        async removeSummon(ref) {
            /* Each of them, properly. This called `.delete()` on a plain
             * object and did nothing at all, so a summon outlived its spell
             * even once the lifetime ended. */
            for (const made of ref?.made ?? []) emitRemoveConjured({ actorUuid: made.actorUuid });
        },

        /**
         * NOT YET ENFORCED — recorded, announced, and read by nothing.
         *
         * The flag has always been written and no code anywhere has ever read
         * it, so Downpour has never actually stopped a fire spell. Making it
         * real needs a decision this layer cannot make on its own: the
         * suppression is AREA-shaped ("counteracts fire effects in the area")
         * but none of the three spells that use it creates a zone, so there is
         * nothing that knows who is standing inside one. It also needs a
         * tag→status table — does `fire` stop `burning` only, or any spell
         * whose element is fire, or both?
         *
         * Until that is settled the honest thing is to say so out loud rather
         * than let a GM believe the fire is being held off. The record is
         * still written so the effect shows on the sheet and a GM can rule it
         * at the table.
         */
        async counteract(a = actor, { tag, beatenBy, record }) {
            /* SUPPRESSION, and it is enforced now.
             *
             * This wrote `enforced: false` onto a flag and popped a "please
             * apply this by hand" notification, and the comment was honest
             * about it: nothing anywhere read the flag. Downpour never stopped
             * a fire, Puro Dwr never negated a poison, White Flame never
             * dispelled anything.
             *
             * Two things read it now — `applyStatus` below, which drops a
             * status whose tag is suppressed, and the cast frame, which
             * refuses a spell of a suppressed element. `beatenBy` is the
             * pushed-through case: White Flame lets a water spell land if the
             * caster BEATS the priest's roll, where Downpour's fire ban is
             * absolute. */
            const flag = { tag, beatenBy: beatenBy ?? null,
                           casterRoll: record?.casterRoll ?? null,
                           source: item?.uuid ?? null, id: record?.castId ?? foundry.utils.randomID(8),
                           enforced: true };
            const list = [...(a.getFlag(SYSTEM_ID, "counteract") ?? []), flag];
            await a.setFlag(SYSTEM_ID, "counteract", list);
            return flag;
        },

        async removeCounteract(ref) {
            /* Matched by id, not by object identity: the list is round-tripped
             * through `getFlag`, so the object handed back here is never the
             * same object that went in and the old `f !== ref` filter removed
             * nothing at all. */
            const id = ref?.id ?? null;
            const list = (actor.getFlag(SYSTEM_ID, "counteract") ?? [])
                .filter(f => (id ? f.id !== id : f.tag !== ref?.tag));
            await actor.setFlag(SYSTEM_ID, "counteract", list);
        },

        /**
         * Is `tag` currently suppressed on this actor, and can `roll` push
         * through it? Returns the entry that stops it, or null.
         */
        suppressing(a = actor, tag, roll = null) {
            for (const f of (a?.getFlag?.(SYSTEM_ID, "counteract") ?? [])) {
                if (f?.tag !== tag || f?.enforced === false) continue;
                /* Absolute, or beaten only by a better roll. */
                if (f.beatenBy == null) return f;
                if (!(Number(roll) > Number(f.beatenBy))) return f;
            }
            return null;
        },

        /* ── Clocks ──────────────────────────────────────────────────────── */

        async scheduleEachRound(a = actor, { rounds, run, record }) {
            registerClock({ actor: a, item, rounds, run, record });
        },

        async scheduleAfter(a = actor, { rounds, run, record }) {
            registerClock({ actor: a, item, rounds, run, record, once: true });
        },

        /**
         * A recurring save that actually happens.
         *
         * This used to write an ActiveEffect carrying `extra.save` and stop
         * there. Nothing in the system ever read that flag, so the save was
         * never rolled — eight spells authored one and none of them ever got
         * a chance to shake it off. Worse, five of those also declare
         * `until: "saveEnds"`, and a lifetime whose only end condition is a
         * save that never fires is a permanent effect.
         *
         * The flag is still written (the sheet shows what is hanging over
         * you); the clock beside it is what makes it real.
         */
        async registerSave(target, { skill, dc, cadence, escalate, mode, record }) {
            emitApplyAuthoredEffects({
                targetUuid: target?.uuid,
                payloads: [effectPayload({
                    name: `${item?.name ?? "Effect"} (save)`,
                    changes: [],
                    record, item,
                    extra: { save: { skill, dc, cadence, escalate } }
                })]
            });

            const threshold = Number(dc) || 0;
            const step = Number(escalate) || 0;
            const flavour = game.i18n.localize(`WITCHER.Defense.${skill}`);
            let bonus = 0;
            let entry = null;

            const attempt = async () => {
                /* ESCALATION HAS A DIRECTION, and it was fixed the wrong way.
                 *
                 * Applying it as a growing bonus to the defender makes every
                 * failed round EASIER. Seirff Haul is the corpus's only user
                 * and its rule is the opposite: "every round that the target
                 * fails the check, the DC rises by 1 as the serpents tighten".
                 * A positive `escalate` now raises the bar, which is what the
                 * word means; a spell that wants to make escape easier says so
                 * with a negative one. */
                bonus += step;

                /* ROLL-UNDER is a real mode in this book — "the target can roll
                 * 1d10; if they roll under their INT the effect ends" — and
                 * there was no way to express it, so Web of Lies was authored
                 * as a roll-over against WILL×3 and became mathematically
                 * impossible: DC 24 against a maximum roll of 16. */
                if (mode === "rollUnder") {
                    const bare = await extendedRoll(`1d10`, {
                        speaker: ChatMessage.getSpeaker({ actor: target }),
                        flavor: `${item?.name ?? ""} — ${flavour}`
                    }, { showResult: false });
                    /* The bare number on the sheet, wherever it lives.
                     *
                     * "Roll under their INT" is a stat; the system's own stun
                     * save is "roll under your Stun", which is a DERIVED stat.
                     * Reading only `system.stats` made the second one a
                     * threshold of 0 — a save nobody could ever make — so Axii
                     * could not be authored the way the book prints it. */
                    const sys = target?.system ?? {};
                    const derived = sys.derivedStats?.[skill];
                    const under = Number(sys.stats?.[skill]?.value
                                      ?? derived?.value ?? derived) || 0;
                    if ((bare?.total ?? 99) >= under) return;
                } else {
                    const roll = await extendedRoll(`1d10 + ${skillTotal(target, skill)}`, {
                        speaker: ChatMessage.getSpeaker({ actor: target }),
                        flavor: `${item?.name ?? ""} — ${flavour}`
                    }, { showResult: false });

                    if ((roll?.total ?? 0) < threshold + bonus) return;
                }

                /* Made it. End everything this cast left on them that says it
                 * ends on a save — and take the effects off through the GM,
                 * because the saver is rarely the caster. */
                endWhere(e => e.owner === target
                           && e.record?.castId === record?.castId
                           && e.conditions?.includes(ENDS.SAVE_ENDS), ENDS.SAVE_ENDS);
                emitRemoveAuthoredEffects({
                    targetUuid: target?.uuid,
                    match: record?.castId ? { castId: record.castId }
                                          : { name: `${item?.name ?? "Effect"} (save)` }
                });
                if (entry) cancelClock(entry);
                await ChatMessage.create({
                    speaker: ChatMessage.getSpeaker({ actor: target }),
                    content: game.i18n.format("WITCHER.Magic.SaveMade",
                        { target: target?.name ?? "", item: item?.name ?? "" })
                });
            };

            /* Only `round` has a clock. Every saveEnds in the corpus is
             * per-round; anything else is recorded on the effect and left to
             * the table rather than silently mapped onto the wrong cadence. */
            if ((cadence ?? "round") === "round") {
                entry = registerClock({ actor: target, item, rounds: null, record, run: attempt });
            } else {
                console.warn(`${SYSTEM_ID} | ${item?.name ?? "a spell"} saves each "${cadence}", which has no clock — it will not roll itself`);
            }
        },

        async beginConcentration(a = actor, { perRound, item: source, record }) {
            /* Both halves of the rule, and the second is the one that gets
             * forgotten: a maintained spell also bars its caster from casting
             * anything else while it holds. */
            await a.setFlag(SYSTEM_ID, "concentration", {
                perRound, item: source?.uuid ?? null, casterRoll: record?.casterRoll ?? null,
                /* The cast's own id, so when the upkeep lapses the sweep can
                 * lift what this spell put on OTHER people too — a telepathic
                 * link lives on its subject, not on the caster paying for it. */
                record: { castId: record?.castId ?? null }
            });
        },

        async releaseConcentration(a = actor) { await a.unsetFlag(SYSTEM_ID, "concentration"); },

        /**
         * Stop this caster's per-round clocks.
         *
         * `core:repeatEachRound` registers with `rounds: null` for anything the
         * book measures by "while you maintain it", and nothing ever cancelled
         * those: a Merigold's Hailstorm dropped when the upkeep lapsed kept
         * damaging the same square, and a Magic Trap kept attacking, for the
         * rest of the session.
         */
        cancelClocks(a = actor) { cancelClocksFor(a); },

        /* ── Standing magic ──────────────────────────────────────────────── */

        async magicOn(target, { kinds }) {
            return (target?.effects ?? [])
                .filter(e => kinds.includes(e.getFlag(SYSTEM_ID, "magicKind")))
                .map(e => ({ id: e.id, effect: e, record: e.getFlag(SYSTEM_ID, "record") ?? {} }));
        },

        async endMagic(target, entry) {
            /* Same ownership trap as removeModifier: the direct delete only
             * worked on actors the dispeller happened to own, and the status
             * fallback only removed a STATUS — an effect carrying a stat
             * change and no status id survived Dispel entirely. */
            const castId = entry?.record?.castId ?? entry?.effect?.getFlag?.(SYSTEM_ID, "record")?.castId;
            emitRemoveAuthoredEffects({
                targetUuid: target?.uuid,
                match: castId ? { castId } : { name: entry?.effect?.name }
            });
            const statusId = entry?.effect?.statuses?.first?.() ?? null;
            if (statusId) {
                await this.removeStatus?.(target, statusId);
            }
            /* And the lifetime that was waiting to be dispelled learns that it
             * WAS — `untilDispelled` had no producer at all, so an effect
             * wearing it was permanent even after Dispel stripped its
             * ActiveEffect, and its `onExpire` never ran. */
            endOnDispel(target, castId ?? null);
        },

        /* ── Asking the table ────────────────────────────────────────────── */

        /** The readable form of a choice id, as a sentence reads it. */
        choiceLabel: (c) => inSentence(localiseChoice(c)),

        async chooseOption(who, { choices, item: source }) {
            const { DialogV2 } = foundry.applications.api;
            return DialogV2.prompt({
                window: { title: source?.name ?? "" },
                content: `<select name="c">${choices.map(c =>
                    `<option value="${c}">${forDisplay(localiseChoice(c))}</option>`).join("")}</select>`,
                ok: { callback: (_e, b) => b.form.elements.c.value }
            }).catch(() => null);           // dismissing is a real answer, not a failure
        },

        async revealInfo(a = actor, { about, to, detail, subjects, record }) {
            const lines = subjects.map(s => describe(s, about)).filter(Boolean);
            await ChatMessage.create({
                content: `<p>${detail ?? ""}</p>${lines.map(l => `<p>${l}</p>`).join("")}`,
                speaker: ChatMessage.getSpeaker({ actor: a }),
                /* Private by default. A diagnostic that posts a monster's exact
                 * remaining HP to the whole table hands everyone information
                 * one character paid five Stamina for. */
                whisper: to === "table" ? [] : [game.user.id]
            });
            return { about, lines };
        },

        async narrate(a = actor, { what, scale, record }) {
            await ChatMessage.create({
                content: `<p class="witcher-narrate ${scale}">${what}</p>`,
                speaker: ChatMessage.getSpeaker({ actor: a })
            });
        },

        /* ── World predicates ────────────────────────────────────────────── */

        async targetHas(target, trait) {
            switch (trait) {
                case "metalGear":
                    /* Same non-existent field — `ifTargetHas: "metalGear"`
                     * could never be true, so every spell gated on the target
                     * wearing metal simply did nothing. */
                    return (target?.items ?? []).some(i => i.system?.equipped &&
                        /metal|steel|iron|chain|plate/i.test(i.system?.material ?? i.name ?? ""));
                case "beast":
                    /* `system.sentient` does not exist — no data model in the
                     * system declares it — so `!undefined` was always true and
                     * "an animal or non-sentient monster" accepted every
                     * monster on the map, and Boiling Blood's whole
                     * restriction was unenforceable.
                     *
                     * The real axis is the monster's CATEGORY, which every
                     * monster carries (`MONSTER_TYPES`). Beasts and insectoids
                     * are the unthinking ones; humanoids, vampires and the
                     * rest plainly are not. */
                    return target?.type === "monster"
                        && ["beast", "insectoid"].includes(String(target.system?.category ?? ""));
                default:
                    return (target?.items ?? []).some(i => i.name === trait)
                        || !!target?.statuses?.has?.(trait);
            }
        },

        async environmentIs(a = actor, condition) {
            const scene = canvas.scene;
            /* THE SYSTEM ALREADY MODELS LIGHT, and this asked a flag instead.
             *
             * `daylight` was read here and written nowhere — no code path in
             * the system sets it — so `directSunlight` was always false and
             * `anyLight` always true (`undefined !== "none"`). Mirror Effect's
             * full-damage branch was therefore unreachable in any world out of
             * the box, and its "cannot be used where the sun cannot reach"
             * veto never fired either.
             *
             * `mechanics/light-level.mjs` is the real answer: it samples the
             * ambient and token light sources at a point on the canvas. The
             * scene flag is kept as an explicit GM override, because a GM who
             * has said "this cave is pitch dark" should outrank the lamp
             * somebody left on the map. */
            const override = scene?.getFlag(SYSTEM_ID, "daylight") ?? null;
            if (override != null) {
                if (condition === "directSunlight") return override === "direct";
                if (condition === "anyLight")       return override !== "none";
            }
            if (condition === "directSunlight" || condition === "anyLight") {
                try {
                    const { lightLevelAt, LIGHT_TIERS } = await import("../mechanics/light-level.mjs");
                    /* Takes the TOKEN, and answers for where it stands. */
                    const tier = lightLevelAt(tokenOf(a));
                    if (tier) {
                        return condition === "directSunlight"
                            /* The sun itself, not a torch: only the two
                             * daylight-grade tiers are "the sun's rays". */
                            ? tier === LIGHT_TIERS.DAYLIGHT || tier === LIGHT_TIERS.BRIGHT
                            /* Any light at all — everything but the two dark
                             * tiers, which is exactly where Mirror Effect
                             * "cannot be used". */
                            : tier !== LIGHT_TIERS.DARKNESS && tier !== LIGHT_TIERS.PITCH;
                    }
                } catch (_) { /* no canvas, or a scene without lighting: fall through */ }
                /* Unknown rather than false: a spell that needs sunlight should
                 * not silently deal zero damage because the map has no lights
                 * configured. The GM sets the flag and it is answered above. */
                return condition === "anyLight";
            }
            return !!scene?.getFlag(SYSTEM_ID, condition);
        },

        async onDeflect(a = actor, { scatter, incoming }) {
            await ChatMessage.create({
                content: `<p>${game.i18n.format("WITCHER.Magic.Deflected", { scatter })}</p>`,
                speaker: ChatMessage.getSpeaker({ actor: a })
            });
        },

        /* A negate-magic ward (Heliotrope, Demetia's Crest Surge, any charge
         * shield) cancelled an incoming cast. `source` is the incoming cast's
         * record; the caster supplies `element` and `name` when it has them.
         * Posts a dedicated, element-accented card so the table sees the ward
         * fire instead of a silent 0-damage result. Every field is optional —
         * an authored cast that omits them still gets a clean card. */
        async onNegate(a = actor, { source } = {}) {
            const rawEl    = String(source?.element ?? "").trim().toLowerCase();
            const element  = rawEl ? rawEl.charAt(0).toUpperCase() + rawEl.slice(1) : "";
            const spell    = String(source?.name ?? "").trim();
            const defender = a?.name || "The ward";
            const text = element
                ? game.i18n.format("WITCHER.Magic.Negated", { defender, element })
                : game.i18n.format("WITCHER.Magic.NegatedNoElement", { defender });
            const suffix = spell ? ` <em class="witcher-ward-negated-spell">(${spell})</em>` : "";
            const accent = { fire: "#c8654a", water: "#3a6aa0", earth: "#7a9a3a", air: "#8fa6b4", mixed: "#8a1d3c" }[rawEl] ?? "#8a5a9a";
            await ChatMessage.create({
                content: `<div class="witcher-ward-negated" style="display:flex;align-items:center;gap:8px;padding:6px 10px;border-left:3px solid ${accent};background:color-mix(in srgb, ${accent} 12%, transparent);"><i class="fa-solid fa-shield-halved" style="color:${accent};flex:0 0 auto;"></i><span>${text}${suffix}</span></div>`,
                speaker: ChatMessage.getSpeaker({ actor: a })
            });
        }
    };
}

/* ── Helpers ───────────────────────────────────────────────────────────────*/

/**
 * The engine's defence names, spelled the way the defence dialog reads them.
 *
 * The dialog's gate is a set of literal string tests — `allowed.has(
 * "resistmagic")`, `allowed.has("spellcasting")` — and it knows nothing of
 * `blockOrDodge`. The engine's vocabulary is camelCase and includes the
 * combined option, so the two never met: a spell declaring `resistMagic`
 * produced a gate with every button false, and the dialog's "nothing is
 * possible" branch does not run either (it needs an EMPTY list), so the
 * defender was simply never asked. Thirty-three of the hundred and three
 * entries defend with `resistMagic`, `blockOrDodge` or `spellCasting`.
 *
 * Normalising here rather than renaming the corpus keeps the two vocabularies
 * separate on purpose: `defence.type` is the engine's, and a block's `skill:`
 * argument is the ACTOR SCHEMA's (`resistmagic`). They look alike and are not
 * the same list.
 */
export function dialogDefences(options = []) {
    const out = new Set();
    for (const o of options ?? []) {
        switch (String(o)) {
            case "resistMagic":  out.add("resistmagic"); break;
            case "spellCasting": out.add("spellcasting"); break;
            /* "Block or Dodge" is a CHOICE of two, and the gate has no such
             * key — it has one per defence. Offer both and let them pick. */
            case "blockOrDodge": out.add("block"); out.add("dodge"); break;
            case "heliotrope":   out.add("heliotrope"); break;
            default:             out.add(String(o));
        }
    }
    return [...out];
}

/**
 * Names this engine uses that the actor schema spells differently.
 *
 * The corpus was authored from the rulebook, where skills are printed as
 * "Resist Magic" and "Dodge/Escape". The schema keys are lower-case and
 * shorter. Nothing reconciled them, so every one of these looked up nothing,
 * returned 0, and produced a defence roll of 1d10+0.
 */
const SKILL_ALIASES = Object.freeze({
    resistMagic:        "resistmagic",
    resistCoercion:     "resistcoerc",
    dodgeEscape:        "dodge",
    wildernessSurvival: "wilderness",
    firstAid:           "firstaid",
    /* No swimming skill exists; the book resolves swimming under Athletics. */
    swimming:           "athletics",
    /* Not a skill but a CHOICE of two. Only one of them is rollable here. */
    blockOrDodge:       "dodge"
});

/* In-flight status removals, keyed `actorUuid:statusId` — see removeStatus.
 * Module-scoped rather than per-adapter because an adapter is built per cast
 * and the racing removals come from lifetimes that outlive theirs. */
const REMOVING = new Map();

const STAT_KEYS = Object.freeze(["int","ref","dex","body","spd","emp","cra","will","luck"]);

/**
 * A skill's full total — governing stat INCLUDED.
 *
 * The old reader did `skill.attribute` and `stats[...].current`. Neither field
 * exists: skills are grouped BY their governing stat (`system.skills.will.
 * spellcast`), and a stat holds `value`, not `current`. So this returned the
 * bare rank and every magic roll in the engine was short by the caster's stat.
 *
 * The schema already computes the answer as `skill.total` — the same number
 * the cast dialog shows — so prefer it and only reconstruct if it is absent.
 */
function skillTotal(a, key) {
    const name = SKILL_ALIASES[key] ?? key;
    for (const [statKey, group] of Object.entries(a?.system?.skills ?? {})) {
        const skill = group?.[name];
        if (!skill) continue;
        const total = Number(skill.total);
        if (Number.isFinite(total)) return total;
        return (Number(skill.value) || 0) + (Number(skill.modifier) || 0)
             + (Number(a?.system?.stats?.[statKey]?.value) || 0);
    }
    /* Some entries name a STAT where a skill is expected (saveEnds skill:"int"). */
    if (STAT_KEYS.includes(name)) return Number(a?.system?.stats?.[name]?.value) || 0;
    /* And some name a derived stat (saveEnds skill:"stun"). */
    const derived = a?.system?.derivedStats?.[name];
    if (derived != null) return Number(derived?.value ?? derived) || 0;
    return 0;
}

/**
 * Where a modifier to `stat` is written.
 *
 * Two of the three branches pointed at fields that do not exist: a stat holds
 * `modifier`, not `modifiers`, and `system.skillModifiers` is not part of the
 * actor schema at all — it appears nowhere else in the repo. So every
 * `grantModifier` in the corpus wrote to nothing: Yrden's SPD/REF penalties,
 * Stammelford's Earthquake, Eilhart's permanent -1 INT, and every skill buff.
 */
function statPath(stat, a) {
    const name = SKILL_ALIASES[stat] ?? stat;
    if (name in { hp: 1, sta: 1 })  return `system.derivedStats.${name}.value`;
    if (name === "health")          return "system.derivedStats.hp.value";
    if (name === "stamina")         return "system.derivedStats.sta.value";
    if (name === "vigor")           return "system.derivedStats.vigor";
    /* LUCK IS A POOL, NOT A STAT WITH A MODIFIER.
     *
     * `luckField()` declares `{ value, max }` and nothing else — there is no
     * `modifier` on it (see data/actor/templates/stats.mjs). Sending Luck of
     * the Father and Blessing of Fortune to `system.stats.luck.modifier` wrote
     * to a path the schema does not define: no error, no warning, and no
     * points. The pool a player actually spends from is `.value`, which is
     * what the sheet decrements. */
    if (name === "luck")            return "system.stats.luck.value";
    if (STAT_KEYS.includes(name))   return `system.stats.${name}.modifier`;
    /* A skill lives under its governing stat, so the group has to be found. */
    for (const [statKey, group] of Object.entries(a?.system?.skills ?? {})) {
        if (group && name in group) return `system.skills.${statKey}.${name}.modifier`;
    }
    /* Derived stats that are plain numbers (meleeBonus, damageBonus, stun...). */
    if (a?.system?.derivedStats && name in a.system.derivedStats) {
        const cur = a.system.derivedStats[name];
        return cur != null && typeof cur === "object"
            ? `system.derivedStats.${name}.value`
            : `system.derivedStats.${name}`;
    }
    return null;                       // nothing to write — the caller reports it
}

const tokenOf = (a) => a?.getActiveTokens?.()?.[0] ?? null;

/** One bounded number out of a person. Returns null if they dismiss it. */
async function numberPrompt({ title, label, value, min, max }) {
    const { DialogV2 } = foundry.applications.api;
    const picked = await DialogV2.prompt({
        window: { title },
        content: `<label>${label}<input type="number" name="n" value="${value}" min="${min}" max="${max}" autofocus></label>`,
        ok: { callback: (_e, b) => Number(b.form.elements.n.value) }
    }).catch(() => null);
    if (!Number.isFinite(picked)) return null;
    return Math.min(max, Math.max(min, picked));
}

/* Witchers never get the Focus discount. Module-level rather than a method,
 * because only `applyFocusDiscount` needs it and the adapter's surface is a
 * contract — anything on it that no spell reaches for is interface nobody
 * asked for, which is how the previous one ended up half-dead. */
/* ── Charge-counted wards ─────────────────────────────────────────────────
 *
 * A ward measured in BLOCKS rather than hit points: Demetia's Crest Surge
 * turns aside a number of water spells and has no pool at all. It gets its own
 * badge, separate from the `castShield` one, because that badge is bound to
 * `system.derivedStats.shield` by two hooks in `setup/hooks.mjs` — deleting it
 * zeroes the pool, and zeroing the pool deletes it. A ward with no pool must
 * not be caught by either, and a caster holding both a Quen and a Crest must
 * not have one overwrite the other.
 *
 * Keyed by the source item, so "which ward is this" is answerable when the
 * count changes. */
const WARD_FLAG = "castWard";

function wardBadges(a) {
    const all = a?.effects?.contents ?? a?.effects ?? [];
    return [...all].filter(e => !!e.flags?.[SYSTEM_ID]?.[WARD_FLAG]);
}

function findWardBadge(a, itemId = null) {
    const list = wardBadges(a);
    if (!list.length) return null;
    if (!itemId) return list[0];
    return list.find(e => e.flags?.[SYSTEM_ID]?.sourceItemId === itemId) ?? null;
}

/** Charges left on a ward, 0 when there is no badge. */
function wardChargesOf(a, itemId = null) {
    const badge = findWardBadge(a, itemId);
    return Math.max(0, Number(badge?.flags?.[SYSTEM_ID]?.wardCharges) || 0);
}

/**
 * Create, update, or clear a charge ward's badge.
 *
 * `mode: "raise"` is a cast — take-higher, so re-casting a ward can only
 * strengthen it, matching what the HP pool does. `mode: "set"` is a spend.
 * At zero the badge is deleted: the ward is gone, and the sheet should say so
 * without the player having to count.
 */
async function writeWardCharges(a, n, { itemId = null, wardName = null, img = null,
                                        absorbs = null, record = null, mode = "set" } = {}) {
    const badge = findWardBadge(a, itemId);
    const held  = Math.max(0, Number(badge?.flags?.[SYSTEM_ID]?.wardCharges) || 0);
    const want  = Math.max(0, Math.floor(Number(n) || 0));
    const next  = mode === "raise" ? Math.max(want, held) : want;
    try {
        if (next <= 0) {
            if (badge) await badge.delete();
            return { charges: 0 };
        }
        const label = wardName
            ?? badge?.flags?.[SYSTEM_ID]?.wardName
            ?? game.i18n.localize("WITCHER.Magic.Shield");
        /* The count is IN THE NAME. A badge that reads "Demetia's Crest Surge"
         * and nothing else tells the caster a ward is up but not how much of it
         * is left, which is the only number that matters while deciding whether
         * to spend an action re-casting it. */
        const name = game.i18n.format("WITCHER.Magic.WardCharges", { name: label, charges: next });
        const payload = {
            [WARD_FLAG]:  true,
            wardCharges:  next,
            wardName:     label,
            wardAbsorbs:  absorbs ?? badge?.flags?.[SYSTEM_ID]?.wardAbsorbs ?? null,
            magicKind:    record?.kind ?? badge?.flags?.[SYSTEM_ID]?.magicKind ?? null,
            sourceItemId: itemId ?? badge?.flags?.[SYSTEM_ID]?.sourceItemId ?? null,
            sourceCaster: a?.uuid ?? null,
            casterRoll:   record?.casterRoll ?? badge?.flags?.[SYSTEM_ID]?.casterRoll ?? null
        };
        if (badge) await badge.update({ name, [`flags.${SYSTEM_ID}`]: payload });
        else await a.createEmbeddedDocuments("ActiveEffect", [{
            name,
            img: img ?? "icons/svg/shield.svg",
            origin: a?.uuid, transfer: false, statuses: [],
            flags: { [SYSTEM_ID]: payload }
        }]);
        return { charges: next };
    } catch (err) {
        console.warn(`${SYSTEM_ID} | charge ward write failed`, err);
        return { charges: next };
    }
}

const isWitcher = (a) => !!a?.items?.some?.(i => i.type === "profession" && /witcher/i.test(i.name));

/**
 * The public cast record, stamped onto every effect a cast leaves behind.
 *
 * Three independent rules need it to survive for as long as the effect does —
 * Dispel and Heliotrope price themselves at half the caster's spend and must
 * beat the caster's roll, Holy Fortification re-rolls against the ORIGINAL
 * caster roll of everything on a target, and Puppet re-contests it each round.
 * It is not optional and it is not a block.
 */
const magicFlags = (record, item) => ({
    [SYSTEM_ID]: {
        record: record ? { ...record } : null,
        magicKind: record?.kind ?? null,
        source: item?.uuid ?? null,
        /* The three flags `zoneEffects.onZoneExit` matches on. Set only for
         * effects created by a zone's body — i.e. because somebody stepped
         * INTO it — so that stepping out takes them off again. This is the
         * whole mechanism behind `untilExitZone`, which eleven spells author
         * and which previously had nothing to fire it. */
        ...(record?.zoneTemplate
            ? { zoneTemplate: record.zoneTemplate, zoneRiderMode: "zone", zoneStripOnExit: true,
                /* And how long it LINGERS after they walk out. Freya's
                 * Bravery: "if they leave the area, its effects last for 1d6
                 * rounds; these rounds renew if the person re-enters and
                 * leaves again." The zone layer strips on exit; a linger tells
                 * it to wait instead, and re-entry re-arms it because entering
                 * re-applies the effect from scratch.
                 *
                 * This was declared on the block, evaluated, passed to the
                 * adapter, and read by nothing at all. */
                zoneLingerRounds: record.zoneLinger ?? null }
            : {})
    }
});

function effectPayload({ name, changes, record, item, extra = {} }) {
    return {
        name,
        img: item?.img ?? "icons/magic/symbols/runes-star-blue.webp",
        changes,
        origin: item?.uuid ?? null,
        flags: { ...magicFlags(record, item), [SYSTEM_ID]: { ...magicFlags(record, item)[SYSTEM_ID], ...extra } }
    };
}

const describe = (a, about) => {
    switch (about) {
        case "health": {
            const hp = a?.system?.derivedStats?.hp;
            const crits = (a?.items ?? []).filter(i => i.type === "criticalWound").map(i => i.name);
            return `<strong>${a.name}</strong>: ${hp?.value}/${hp?.max} HP${
                crits.length ? ` · ${crits.join(", ")}` : ""}`;
        }
        default: return null;
    }
};


