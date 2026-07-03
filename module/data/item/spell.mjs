/**
 * SpellData — a castable spell / sign / invocation (RAW Core p.99-115).
 *
 * Fields are structured (not free strings) so the combat / cast flow can
 * reason about them numerically — mirrors HexData / RitualData:
 *   - staminaCost / castingTime  → numbers (STA spent; cost in ACTIONS)
 *   - defense                    → enum: how the target resists
 *                                  (resistmagic | dodge | block | none)
 *   - targetType                 → enum (direct | area | self) — decides
 *                                  whether a defense is rolled at all (p.169)
 *   - duration                   → { value, unit } so round-based spells tick
 *   - school / form / tier       → enums (Earth…Mixed / spell·sign·invocation /
 *                                  Novice·Journeyman·Master)
 *   - components                 → item links ({uuid,name,img,qty}), any type
 *   - effect                     → narrative HTML
 */

import { baseItemSchema } from "./templates/base.mjs";

const fields = foundry.data.fields;

export class SpellData extends foundry.abstract.TypeDataModel {
    static defineSchema() {
        return {
            ...baseItemSchema(),
            staminaCost: new fields.NumberField({ initial: 0, integer: true, min: 0 }),
            // Some spells cost a variable amount (e.g. Dispel spends half the
            // target spell's cost) — flag it so the cast flow prompts and the
            // sheet shows "Variable" instead of the staminaCost default.
            variableCost: new fields.BooleanField({ initial: false }),
            // Cast time as an action count — "1 action" is the number 1.
            castingTime: new fields.NumberField({ initial: 1, integer: true, min: 0 }),
            // How the target resists — a multi-select (a spell can offer more
            // than one valid defense, e.g. "Dodge or Block"). Empty = no
            // defense ("None"). Each entry is a SPELL_DEFENSES key.
            defense:     new fields.ArrayField(new fields.StringField(), { initial: ["resistmagic"] }),
            range:       new fields.StringField({ initial: "" }),
            // Structured duration so combat can decrement round-based spells.
            // unit ∈ instant | rounds | minutes | hours | days | permanent.
            // value is a string so RAW dice durations ("1d10", "1d6") round
            // at cast time, not just fixed integers.
            duration:    new fields.SchemaField({
                value: new fields.StringField({ initial: "" }),
                unit:  new fields.StringField({ initial: "instant" })
            }),
            // School & form (Core p.99) — Earth / Air / Fire / Water / Mixed,
            // plus a form distinguishing mage spell vs witcher sign vs priest
            // invocation. Signs share STA-cost mechanics but cap at 7 STA per
            // cast (Core p.115).
            school:      new fields.StringField({ initial: "mixed" }),
            spellForm:   new fields.StringField({ initial: "spell" }),
            // RAW tier — gates the Magic Training rank needed to learn it.
            spellType:   new fields.StringField({ initial: "novice" }),
            // Targeting (Core p.169) — direct / area / self decides whether
            // the defender rolls a defense at all.
            targetType:  new fields.StringField({ initial: "direct" }),
            effect:      new fields.HTMLField({ initial: "" }),
            // Structured damage the cast deals on a successful hit. Empty
            // formula = non-damaging (support / utility spells). Supports
            // scaling placeholders resolved at cast time:
            //   {sta}    → replaced by the STA spent on this cast (Igni,
            //              Fire Stream, Magic Trap variants)
            //   {margin} → replaced by (attack roll − defense) at damage
            //              time (Carys' Hail, Cenlly Graig, Bronwyn's Gust)
            // variableCost items let the caster edit the formula per-cast.
            damageFormula: new fields.StringField({ initial: "" }),
            // Damage element enum (SPELL_DAMAGE_ELEMENTS) — the element
            // riders + the calculator's per-type resist / immunity lookup
            // match on THIS, not `school`.
            damageElement: new fields.StringField({ initial: "none" }),
            // Damage resource type (SPELL_DAMAGE_TYPES) — hp is the
            // default, but the corpus also has STA drain (Blaze of Korath),
            // armor ablation (Rusting), weapon reliability, and shield
            // HP pools (Quen). Downstream damage-apply reads this to pick
            // the right subtraction path.
            damageType: new fields.StringField({ initial: "none" }),
            // Tangibility — TRUE = the cast is physical/material (fire,
            // rocks, lightning, ice, impact). Active Shield / Quen drains
            // its HP first, and any status riders on this cast are
            // absorbed by the shield too. FALSE = the cast is incorporeal
            // (suffocation, noxious fumes, mental effects, curses) — it
            // bypasses the shield entirely: damage lands on HP directly
            // and status riders always apply. Defaults TRUE because most
            // damaging spells are physical; author flips it off for the
            // "gas cloud through a bubble" cases.
            tangible: new fields.BooleanField({ initial: true }),
            // Area of effect shape + size (metres). areaShape="none" means
            // single-target. Combined with `targetType` (which stays as
            // direct/area/self — the tactical intent) so a "cone 3m" reads
            // as `{targetType:"area", areaShape:"cone", areaSize:3}`.
            areaShape: new fields.StringField({ initial: "none" }),
            areaSize:  new fields.NumberField({ initial: 0, integer: false, min: 0 }),
            // Area anchor — controls whether the template's ORIGIN is
            // locked to the caster ("caster") or can be freely placed
            // in line of sight ("free"). Caster-anchored casts still
            // let the player aim the direction with the mouse (and
            // fine-tune with the wheel); free casts let the player
            // position AND rotate. Signs, self-emanating cones/lines
            // and personal domes should stay "caster"; ranged zone
            // spells (Fire Wall in the distance, Lightning Storm,
            // Cinder Door) should be "free". Default caster.
            areaAnchor: new fields.StringField({ initial: "caster" }),
            // Status effects the cast can inflict on a successful hit.
            // Each rider: { statusId, chance (%), duration:{value,unit},
            //               mode, stripOnExit, staScale }.
            // The chance is rolled per target after damage lands (mode:
            // "onHit"), or on zone entry (mode: "zone"), or each round
            // while inside (mode: "onTick"). Duration ties into the
            // status engine's tick / expiry machinery.
            //
            // Modes:
            //   onHit  → default. Rolled once per target when the cast
            //            hits (Aenye burning 75%, Water Jet prone 100%,
            //            Korath's Breath blinded 1d6 rounds).
            //   zone   → applied when a token ENTERS a persistent-area
            //            template (Yrden -N to REF/DEX, Static Storm
            //            2 dmg/rd via `staScale`). Requires areaPersist.
            //   onTick → applied fresh each round to tokens inside a
            //            persistent zone (Blaze of Korath ticking STA
            //            drain — the tick fires independently of entry).
            //
            // stripOnExit:
            //   TRUE  = the zone status is removed when the token walks
            //           OUT of the template (Yrden aura pattern —
            //           default for mode:"zone").
            //   FALSE = once applied, the status persists for its own
            //           duration regardless of position (curse marker
            //           pattern — Curse of Sedna).
            //
            // staScale (encodes errata Yrden formula precisely):
            //   magnitude = offset * (1 + floor((staSpent - 1) / divisor))
            //   clamped by `cap` (negative for penalties, positive for
            //   bonuses)
            //   `offset` is BOTH the base magnitude at STA=1 AND the
            //   per-step delta. Sign is preserved: negative offset →
            //   penalty grows MORE negative every `divisor` STA;
            //   positive offset → bonus grows more positive.
            //   Errata Yrden: { offset: -1, divisor: 2, cap: -4 } →
            //     1 STA:-1, 3 STA:-2, 5 STA:-3, 7 STA:-4 (hard-capped).
            //   Ignored when staScale = { 0, 1, 0 } / all zeros
            //   → the status applies with its clause's fixed magnitude.
            statusRiders: new fields.ArrayField(new fields.SchemaField({
                statusId:    new fields.StringField({ required: true, blank: false }),
                chance:      new fields.NumberField({ initial: 100, integer: true, min: 0, max: 100 }),
                duration:    new fields.SchemaField({
                    value: new fields.StringField({ initial: "" }),
                    unit:  new fields.StringField({ initial: "instant" })
                }),
                mode:        new fields.StringField({ initial: "onHit" }),
                stripOnExit: new fields.BooleanField({ initial: true }),
                staScale:    new fields.SchemaField({
                    offset:  new fields.NumberField({ initial: 0, integer: true }),
                    divisor: new fields.NumberField({ initial: 1, integer: true, min: 1 }),
                    cap:     new fields.NumberField({ initial: 0, integer: true })
                })
            })),
            // Magical Gifts (A Tome of Chaos pp.74-75) are non-mage minor magic
            // (spellForm "gift") carrying a mandatory side-effect; its text lives here.
            sideEffect:  new fields.HTMLField({ initial: "" }),
            // Required materials / foci, as links to real items (any type),
            // each with a quantity. Most RAW spells need none.
            components:  new fields.ArrayField(new fields.SchemaField({
                uuid: new fields.StringField({ required: true, blank: false }),
                name: new fields.StringField(),
                img:  new fields.StringField(),
                qty:  new fields.NumberField({ initial: 1, integer: true, min: 1 })
            })),
            /* ── Narrative-only escape hatch ──────────────────────────
             * Not every RAW spell fits a schema — some are one-off
             * meta-effects (scrying futures, memory locks, cross-scene
             * teleport). Mark such spells `narrative: true` and the
             * sheet suppresses every mechanic block, the cast dialog
             * shows a roll + description only, and the chat card posts
             * `effect` HTML with no auto-apply. GM adjudicates from
             * there. The spell still rolls its Spell Casting check
             * against `defense[]` if authored. */
            narrative: new fields.BooleanField({ initial: false }),
            /* ── Handler registry key ─────────────────────────────────
             * Named entry in `SPELL_HANDLERS` (module/mechanics/
             * spellHandlers.mjs). When set, the cast flow invokes the
             * handler at documented hook points (`onCastDialog`,
             * `onBeforeRoll`, `onAfterRoll`, `onDamageApplied`,
             * `onDefend`) so bespoke behavior can mutate castContext
             * without adding one-off schema fields. Empty = pure
             * schema path. Examples: "empower", "dispel", "wrath-of-
             * nature", "steal-spell", "omens-of-the-future". */
            mechanicHandler: new fields.StringField({ initial: "" }),
            /* ── Casts authored-AE spells ─────────────────────────────
             * When TRUE, the cast flow deep-clones each of the ITEM's
             * embedded ActiveEffects onto every hit target (or onto
             * the caster for self-buffs), applying the spell's
             * `duration` to the AE if the AE has no explicit
             * duration of its own. This is the idiomatic Foundry
             * path for simple stat/skill buffs (Sharpen Senses,
             * Glamour, Freya's Bravery, Champion of the River) — the
             * GM authors an AE with `transfer: false` on the item
             * sheet, sets `changes: [{ key, mode, value }]` per axis,
             * and the cast copies it to targets.
             *
             * Independent of `grants[]` (which is a lightweight
             * schema-only path for cases where a spell needs a
             * single delta but the GM doesn't want to open the AE
             * editor). Both can be set; both apply.
             *
             * Skipped for `narrative: true` items — narrative casts
             * don't auto-apply anything. */
            castsAuthoredAE: new fields.BooleanField({ initial: false }),
            /* ── Persistent zone ──────────────────────────────────────
             * TRUE = the placed template stays on the canvas for the
             * spell's `duration`. `updateToken` diffs a token's before/
             * after center against the template shape; entry applies
             * the zone's status riders (those with mode:"zone"), exit
             * strips them (when `stripOnExit`). `combatRound` ticks
             * down the roundsRemaining flag and deletes the template
             * at zero. Yrden, Static Storm, Consecrate, Blaze of the
             * Korath, Freshen Air. */
            areaPersist:       new fields.BooleanField({ initial: false }),
            /* Caster stands inside their own Yrden without being
             * penalised. Independent of `areaPersist` — a one-shot
             * AoE damage spell can also exclude the caster. */
            areaExcludeCaster: new fields.BooleanField({ initial: true }),
            /* ── Damage cadence ───────────────────────────────────────
             * When a persistent zone has a damage formula, WHEN does it
             * apply?
             *   cast    → one-shot at placement (default; matches AoE
             *             fireball behavior)
             *   round   → tick every round on tokens inside (Static
             *             Storm 2 dmg/rd, Blaze of Korath, Melgar's
             *             Fire recurring)
             *   onEnter → applies each time a token enters (damage
             *             plus a status; Wall of Fire variants) */
            damagePer: new fields.StringField({ initial: "cast" }),
            /* ── Piercing beam ────────────────────────────────────────
             * A line spell that passes through multiple targets on its
             * path, dealing progressively less damage per hop.
             * `decayFormula` is subtracted from the damage roll for
             * each subsequent target (Alzur's Thunder −1d6 / hop,
             * Sagitta Aurea, Mirror Effect). */
            pierce: new fields.SchemaField({
                enabled:      new fields.BooleanField({ initial: false }),
                decayFormula: new fields.StringField({ initial: "" })
            }),
            /* ── Pre-defense hit probability ─────────────────────────
             * Some AoE spells only strike a fraction of targets before
             * the target's own defense roll matters (Melgar's Fire
             * 75%, Lightning Storm 35%, Consecrate). 100 = always
             * strike (default). 0 disables the roll entirely. */
            hitChance: new fields.NumberField({ initial: 100, integer: true, min: 0, max: 100 }),
            /* ── Armor-bypass ─────────────────────────────────────────
             * Damage skips the target's SP entirely (Anialwch). Does
             * NOT bypass Active Shield / Quen — those still drain per
             * `tangible`. */
            bypassArmor: new fields.BooleanField({ initial: false }),
            /* ── Multi-attack count ───────────────────────────────────
             * Formula for how many independent attack rolls the cast
             * makes (Tryferi Gaeaf: `floor(spellcasting/2)`, past-
             * errata Cenlly Graig). Empty = single attack. */
            attackCount: new fields.StringField({ initial: "" }),
            /* ── Ablation scope ───────────────────────────────────────
             * When `damageType: "ablation"`, which slot degrades?
             *   armor   → worn armor SP (Rusting armor mode)
             *   weapon  → weapon reliability (Rusting weapon mode)
             *   shield  → shield reliability
             *   choose  → caster picks at cast time (Smith's Touch) */
            ablationScope: new fields.StringField({ initial: "armor" }),
            /* ── Multi-mode branches ──────────────────────────────────
             * Some casts are one item with multiple discrete
             * mechanical variants selectable at cast time (Wrath of
             * Nature 7 biome branches, Song of the Sky 5 weather
             * modes, Rusting armor/weapon/shield, Cadfan's Grasp
             * drop-or-heat, Hand of the Tempest 3 modes). Each mode
             * overrides the cast's damage / area / riders / defense
             * for that cast. Empty modes[] = single-mode spell. */
            modes: new fields.ArrayField(new fields.SchemaField({
                id:            new fields.StringField({ required: true, blank: false }),
                label:         new fields.StringField({ initial: "" }),
                description:   new fields.HTMLField({ initial: "" }),
                staminaCost:   new fields.NumberField({ required: false, integer: true, min: 0 }),
                damageFormula: new fields.StringField({ initial: "" }),
                damageElement: new fields.StringField({ initial: "" }),
                damageType:    new fields.StringField({ initial: "" }),
                areaShape:     new fields.StringField({ initial: "" }),
                areaSize:      new fields.NumberField({ required: false, integer: false, min: 0 }),
                defense:       new fields.ArrayField(new fields.StringField()),
                statusRiders:  new fields.ArrayField(new fields.SchemaField({
                    statusId: new fields.StringField({ required: true, blank: false }),
                    chance:   new fields.NumberField({ initial: 100, integer: true, min: 0, max: 100 })
                }))
            })),
            /* ── STA tier picker ──────────────────────────────────────
             * Discrete-tier variable cost — the caster picks a STA
             * cost from a fixed set and each tier yields a different
             * effect (Cursed Illness 2/4/6 STA → three effects;
             * Word of Summoning 2/5/10 STA → small/medium/large
             * animal; Quill of the Divine 14 vs 16 STA). Empty
             * variableTiers[] with `variableCost: true` = free
             * continuous variable (Igni, Yrden, Quen — {sta} scales
             * damage/duration formulaically). */
            variableTiers: new fields.ArrayField(new fields.SchemaField({
                staMin:        new fields.NumberField({ initial: 0, integer: true, min: 0 }),
                label:         new fields.StringField({ initial: "" }),
                description:   new fields.HTMLField({ initial: "" }),
                damageFormula: new fields.StringField({ initial: "" }),
                statusRiders:  new fields.ArrayField(new fields.SchemaField({
                    statusId: new fields.StringField({ required: true, blank: false }),
                    chance:   new fields.NumberField({ initial: 100, integer: true, min: 0, max: 100 })
                }))
            })),
            /* ── Escape check ─────────────────────────────────────────
             * How a target throws off a persistent hostile status —
             * Talfryn's Prison (Dodge/Escape vs the original cast
             * roll), Seirff Haul (DC drifts +1/rd), Mental Command
             * (Resist Magic every 1d6 rounds), Crystal Stasis, Puppet.
             *   skill         → skill key rolled by the target
             *   dcSource      → "castRoll" | "fixed" (spell's DC field)
             *   dcDrift       → integer added to the DC per elapsed round
             *   cadence       → "round" | "turn" | "1d6rounds" — how
             *                    often the target may retry
             *   consumesAction → does retrying cost an action? */
            escapeCheck: new fields.SchemaField({
                skill:          new fields.StringField({ initial: "" }),
                dcSource:       new fields.StringField({ initial: "castRoll" }),
                dcDrift:        new fields.NumberField({ initial: 0, integer: true }),
                cadence:        new fields.StringField({ initial: "round" }),
                consumesAction: new fields.BooleanField({ initial: false })
            }),
            /* ── Per-round escalation ─────────────────────────────────
             * A persistent effect that gets WORSE each round it
             * remains (Cinder Door growing damage, Seirff Haul DC
             * climb). `attribute` names the field being escalated
             * (e.g. "damageDice", "dc", "penalty"); `delta` is the
             * per-round change. */
            escalationPerRound: new fields.SchemaField({
                attribute: new fields.StringField({ initial: "" }),
                delta:     new fields.NumberField({ initial: 0, integer: true })
            }),
            /* ── Shield HP pool config ────────────────────────────────
             * Refines `damageType: "shieldHp"` — the current path only
             * establishes a flat pool. RAW variants:
             *   hpPerSta          → Quen 5·STA, Active Shield 10·STA
             *   regenPerSta       → Magic Barrier ticks back N per rd
             *   blocksTangibleOnly → Quen absorbs impact but not
             *                        suffocation / mental (default TRUE)
             *   coversAllies      → 0 = self only; N = shield covers
             *                        N adjacent allies (Dormyn's
             *                        Chamber, Elgan's Bastion)
             *   onExpireEffect    → id of a rider that fires when the
             *                        pool hits 0 (Active Shield → 2m
             *                        push + 1d6 damage) */
            shield: new fields.SchemaField({
                hpPerSta:           new fields.NumberField({ initial: 0, integer: true, min: 0 }),
                regenPerSta:        new fields.NumberField({ initial: 0, integer: true, min: 0 }),
                blocksTangibleOnly: new fields.BooleanField({ initial: true }),
                coversAllies:       new fields.NumberField({ initial: 0, integer: true, min: 0 }),
                onExpireEffect:     new fields.StringField({ initial: "" })
            }),
            /* ── Heal mechanic ────────────────────────────────────────
             *   amount         → dice/flat formula, supports {sta}
             *   per            → "cast" (one-shot) | "round" (Magic
             *                    Healing 3 HP/rd, errata-corrected)
             *   chargesCrit    → N successful casts close a critical
             *                    wound (Magic Healing / Blessing of
             *                    Healing charge system)
             *   cureConditions → status IDs stripped on cast (Feast
             *                    of Plenty cures poison + disease)
             *   regrowLimb     → Miracle of Lebioda regrows a lost
             *                    limb / restores a permanent penalty */
            heal: new fields.SchemaField({
                amount:         new fields.StringField({ initial: "" }),
                per:            new fields.StringField({ initial: "cast" }),
                chargesCrit:    new fields.NumberField({ initial: 0, integer: true, min: 0 }),
                cureConditions: new fields.ArrayField(new fields.StringField()),
                regrowLimb:     new fields.BooleanField({ initial: false })
            }),
            /* ── Buff / grants ────────────────────────────────────────
             * Structured stat/skill/immunity deltas for buff spells
             * (Glamour +3 Seduction/Cha/Leadership, Sharpen Senses,
             * Freya's Bravery +25 HP + fear immune, Champion of the
             * River resistances). One entry per delta.
             *   path      → dot-path into the target actor
             *               (e.g. "system.stats.dex.current",
             *                     "system.skills.dex.dodge.value")
             *   delta     → integer add/subtract
             *   condition → optional predicate string; empty = always */
            grants: new fields.ArrayField(new fields.SchemaField({
                path:      new fields.StringField({ required: true, blank: false }),
                delta:     new fields.NumberField({ initial: 0, integer: true }),
                condition: new fields.StringField({ initial: "" })
            })),
            /* Temp HP pool granted by the spell (Freya's Bravery +25).
             * Formula, supports {sta}. Different from shield pool —
             * temp HP takes damage before real HP and vanishes on
             * duration expiry; shield pool intercepts per tangibility. */
            grantsTempHp: new fields.StringField({ initial: "" }),
            /* ── Summon ───────────────────────────────────────────────
             * Cast summons an actor onto the scene from a compendium
             * (Living Fire fire elemental, Word of Summoning animal
             * tiers, Javed's Swarm SPD-7 insect swarm, Afan's Mirror
             * illusory copies, Conspiracy of the Mother 10 crows,
             * Animate Armor). The summon's stat block is a real actor
             * document referenced by uuid; count may be a formula.
             *   durationOnCasterDeath → "persist" | "dismiss" */
            summon: new fields.SchemaField({
                actorUuid:             new fields.StringField({ initial: "" }),
                count:                 new fields.StringField({ initial: "1" }),
                controlled:            new fields.BooleanField({ initial: true }),
                durationOnCasterDeath: new fields.StringField({ initial: "dismiss" })
            }),
            /* ── Transform ────────────────────────────────────────────
             * Cast turns the caster (or target) into another actor
             * (Polymorphism, Blood of the Berserker → Great Bear,
             * Artifact Compression). Reverts on duration / dispel /
             * recast. `damageMirror: true` = HP delta rides back to
             * the base form on revert (Berserker); false = HP resets. */
            transform: new fields.SchemaField({
                actorUuid:    new fields.StringField({ initial: "" }),
                itemsMerge:   new fields.BooleanField({ initial: false }),
                damageMirror: new fields.BooleanField({ initial: false })
            }),
            /* ── Illusion ─────────────────────────────────────────────
             * A cast that ROLLS damage but doesn't actually reduce
             * HP — instead it triggers a stun-save if the "believed"
             * damage would have KO'd or crit (Interactive Illusion,
             * Blemish, Magic Screen). `believedDamageFormula` fills
             * in for the display / stun-save threshold. */
            illusion: new fields.SchemaField({
                believedDamageFormula: new fields.StringField({ initial: "" }),
                capsAtStun:            new fields.BooleanField({ initial: true })
            }),
            /* ── Trigger condition ────────────────────────────────────
             * A cast that DOESN'T fire immediately — it waits for a
             * later event, then discharges (Magic Trap, Touch of
             * Lightning charged object, Coating of Fire ignition-on-
             * flame, Web of Ice break-on-interact, Trap Portal).
             *   event           → "touch" | "proximity" | "flame" |
             *                     "portal-transit" | "damage"
             *   chargesConsumed → NUMBER of triggers before the spell
             *                     dissipates (default 1) */
            triggerCondition: new fields.SchemaField({
                event:           new fields.StringField({ initial: "" }),
                chargesConsumed: new fields.NumberField({ initial: 1, integer: true, min: 0 })
            })
        };
    }

    static migrateData(data) {
        // castingTime: legacy free string "1 action" → leading integer.
        if (typeof data.castingTime === "string") {
            const n = parseInt(data.castingTime, 10);
            data.castingTime = Number.isFinite(n) ? n : 1;
        }
        // defense: legacy free string / single enum → array of enum keys
        // (matches the RAW "Defense:" wordings — "Dodge or Block" → both,
        // opposed "Spell Casting", GM-set DC, "None" → empty).
        if (typeof data.defense === "string") {
            const s = data.defense.trim();
            const out = [];
            if (/dodge|reflex|evade/i.test(s)) out.push("dodge");
            if (/block|parry/i.test(s))        out.push("block");
            if (/resist|magic|will/i.test(s))  out.push("resistmagic");
            if (/spell\s*cast|opposed/i.test(s)) out.push("spellcasting");
            if (/\bgm\b|game\s*master|discretion/i.test(s)) out.push("gm");
            // Legacy single-key "dodgeblock" splits into both.
            if (s === "dodgeblock") { out.push("dodge", "block"); }
            // "None" / "N/A" / "Self" and unmatched non-empty → empty / default.
            data.defense = out.length ? [...new Set(out)]
                         : (/none|n\/a|self/i.test(s) || s === "" ? [] : ["resistmagic"]);
        }
        // duration: legacy free string → { value, unit }. Preserve the
        // leading count token whether it's a dice formula ("1d10") or a
        // plain integer ("5") so the string field keeps the roll.
        if (typeof data.duration === "string") {
            const s = data.duration;
            const token = s.match(/\d+d\d+(?:[+-]\d+)?|\d+/i)?.[0] ?? "";
            let unit = "instant";
            if (/perm|until|indefinit/i.test(s)) unit = "permanent";
            else if (/round/i.test(s))           unit = "rounds";
            else if (/day/i.test(s))             unit = "days";
            else if (/hour/i.test(s))            unit = "hours";
            else if (/min/i.test(s))             unit = "minutes";
            data.duration = { value: token, unit };
        } else if (data.duration && typeof data.duration.value === "number") {
            // structured-but-numeric (earlier schema) → stringify the count.
            data.duration.value = String(data.duration.value);
        }
        // components: legacy HTML string → drop (can't infer item links).
        if (typeof data.components === "string") data.components = [];
        return super.migrateData(data);
    }

    calcWeight() {
        return 0;
    }
}
