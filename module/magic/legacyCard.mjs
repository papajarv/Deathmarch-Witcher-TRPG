/**
 * Speaking the cast card's language.
 *
 * The engine was posting a card of its own design, which looked fine and was
 * a dead end: every downstream feature in this system reads a specific flag
 * shape off the cast message. The damage button, the per-target verdict
 * blocks, the zone hooks, the rider handlers, the crit lookups — all of them
 * find their data through `flags[SYSTEM].castContext` and the `category:
 * "combat"` envelope the attack flow also uses.
 *
 * So a spell on the new engine rolled, resolved, and produced a card nothing
 * could act on. The blocks had already applied their effects, but everything
 * the system offers AROUND a cast — the buttons, the linkage, the templates
 * keyed to the message — was simply absent.
 *
 * This builds that shape from a finished cast context. Nothing here is new
 * behaviour; it is a translation, and the target language is the one the rest
 * of the system already speaks.
 */

/**
 * The `castContext` the old path writes, built from the engine's own.
 *
 * Field names are theirs, not the engine's, and deliberately so — renaming
 * them here would mean renaming them in every consumer.
 */
export function buildCastContext(ctx, { item, actor }) {
    const frame = ctx.frame ?? {};
    const decl = ctx.declaration ?? {};

    return {
        itemUuid:   item?.uuid ?? null,
        casterUuid: actor?.uuid ?? null,
        kind:       item?.type ?? "spell",
        form:       item?.system?.spellForm ?? frame.kind ?? null,
        school:     item?.system?.school ?? null,
        tier:       item?.system?.spellType ?? frame.tier ?? null,

        /* The SPELL's own stamina — the number "1d6 per STA" scales against.
         * Adrenaline is a channelled side-cost and stays separate, which is
         * why the record's total is not reused here. */
        staSpent:           ctx.vars?.sta ?? 0,
        adrenalineStaSpent: Number(decl.adrenalineStaCost) || 0,

        vigorAtCast: ctx.vars?.vigor ?? 0,
        overExertion: {
            threshold:  ctx.vars?.vigor ?? 0,
            priorChaos: ctx.control?.priorChaos ?? 0,
            marginal:   ctx.control?.overExertion ?? 0
        },

        variable: {
            supported: frame.cost?.mode === "variable",
            factor: frame.cost?.mode === "variable" && Number(item?.system?.staminaCost) > 0
                ? (ctx.vars?.sta ?? 0) / Number(item.system.staminaCost)
                : 1
        },

        defense: ctx.record?.defenceSet ?? [],
        targeting: {
            mode:  item?.system?.targetType ?? frame.targeting?.mode ?? "direct",
            range: item?.system?.range ?? ""
        },
        duration: {
            value: item?.system?.duration?.value ?? "",
            unit:  item?.system?.duration?.unit  ?? "instant"
        },

        /* Targets in the consumer's shape. `hit` is filled once the cast has
         * resolved — `castDamage` iterates this to apply per-target damage and
         * skips the ones that missed. */
        targets: (ctx.targets ?? []).map(t => ({
            uuid: t.actor?.uuid ?? null,
            defenseTotal: Number.isFinite(t.defenceTotal) ? t.defenceTotal : null,
            hit: t.hit ?? null
        })),

        /* Fields the consumers still read, and what they mean on this engine.
         *
         * `damage` and `statusRiders` were the OLD engine's behaviour config,
         * and blocks replace both — so they are deliberately EMPTY rather than
         * absent. Absent reads as `undefined` and throws in a consumer that
         * iterates it; empty reads as "this cast declares no damage of its
         * own", which is exactly true. The blocks have already applied theirs.
         *
         * `area`, `tangible` and `components` are not behaviour and still
         * describe the cast, so they are filled from the item as before. */
        damage: null,
        statusRiders: [],

        tangible: item?.system?.tangible !== false,
        area: {
            shape:   frame.targeting?.shape ?? item?.system?.areaShape ?? "none",
            size:    frame.targeting?.size ?? (Number(item?.system?.areaSize) || 0),
            anchor:  item?.system?.areaAnchor ?? "caster",
            persist: !!item?.system?.areaPersist,
            excludeCaster: (frame.targeting?.excludeCaster ?? item?.system?.areaExcludeCaster) !== false
        },
        components: item?.system?.components ?? [],

        /* What the ENGINE did, carried alongside. Nothing downstream reads it
         * yet; it is here so a card can say what actually happened rather than
         * what the spell's text claims. */
        authored: {
            outcome: ctx.control?.outcome ?? null,
            created: (ctx.created ?? []).map(c => ({ kind: c.kind, what: c.what ?? c.status ?? c.stat ?? null }))
        }
    };
}

/**
 * The message flags, in the envelope the attack flow uses.
 *
 * Sharing it is the point: `defenderUuid`, `attackerUuid`, `engagementId` and
 * `attackTotal` are how every downstream lookup finds its way back, and a
 * spell that omits them is a spell no button can act on.
 */
export function buildCastFlags(ctx, { item, actor, total, fumble, engagementId, systemId }) {
    const castContext = { ...buildCastContext(ctx, { item, actor }), castTotal: total, fumble };
    const firstDefender = (ctx.targets ?? []).find(t => t.actor?.uuid)?.actor?.uuid;

    return {
        [systemId]: {
            category:     "combat",
            attackerUuid: actor?.uuid ?? null,
            attackerName: actor?.name ?? "",
            engagementId,
            attackTotal:  total,
            ...(firstDefender ? { defenderUuid: firstDefender } : {}),
            castContext
        }
    };
}

/**
 * The aggregate verdict the damage button gates on.
 *
 * `hit` when ANY target was hit — the per-target loop filters the misses out
 * later. `miss` only when every one of them turned it aside, which is when the
 * button is stripped from the card entirely.
 */
export function castVerdict(ctx) {
    const targets = ctx.targets ?? [];
    if (!targets.length) return ctx.control?.outcome === "success" ? "hit" : "miss";
    return targets.some(t => t.hit) ? "hit" : "miss";
}
