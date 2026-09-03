/**
 * Wiring the spell engine into Foundry.
 *
 * One function, called once from `main.mjs`. Everything it touches is either
 * Foundry-free (the blocks, the frame, the canvas layout) or the adapter,
 * which is the single file that knows Foundry exists.
 *
 * The engine registers its blocks and its hooks and then does nothing until
 * something casts. It does not patch the existing spell path, and it does not
 * take over: an item carries authored trees or it does not, and one without
 * them goes down the old road untouched. That is deliberate — a replacement
 * that switches everything over at once is a replacement nobody can roll back
 * on a Friday night with four players waiting.
 */

import { registerCoreBlocks }      from "./blocks/core.mjs";
import { registerDefensiveBlocks } from "./blocks/defensive.mjs";
import { registerEffectBlocks }    from "./blocks/effects.mjs";
import { registerKnowledgeBlocks } from "./blocks/knowledge.mjs";
import { registerContestBlocks }   from "./blocks/contest.mjs";
import { registerCoreContributors } from "./contributors.mjs";
import { advanceMagicClocks, cancelClocksFor } from "./adapter.clocks.mjs";
import { installStandingHandler, openStandingPanel } from "./standing.mjs";
import { tick, endWhere, duringTick, activeLifetimes, fireCondition, endDestroyed, endWorldEvent, ENDS } from "./lifetimes.mjs";
import { blockCount } from "./registry.mjs";
import { rebuildAllWards, rebuildWardsFor, isEngineHost } from "./wardRegistry.mjs";
import { runHostInterception } from "./intercept.mjs";
import { setInterceptionRunner } from "../setup/socketHook.mjs";
import { foundryAdapter } from "./adapter.mjs";

import { SYSTEM_ID } from "./systemId.mjs";

/** Called during `init`. Blocks must exist before any sheet renders. */
export function registerMagicEngine() {
    registerCoreBlocks();
    registerDefensiveBlocks();
    registerEffectBlocks();
    registerKnowledgeBlocks();
    registerContestBlocks();

    /* Contributed defences — Heliotrope and Dispel are offered against magic
     * whose own defence line reads `None`, which is 52 of the 103 core
     * entries. Without this the commonest case in the book is undefendable. */
    registerCoreContributors();

    console.log(`${SYSTEM_ID} | magic engine: ${blockCount()} blocks registered`);
}

/** Called during `ready`, once the world and its combats exist. */
export function registerMagicHooks() {

    /* ── The engine host owns the ward list ───────────────────────────────
     *
     * `bus.mjs` keeps subscriptions in a module-level array, so there is one
     * per browser, and the browser that raises a ward is never the browser
     * that resolves an attack against it — which is why Demetia's Crest never
     * spent a charge and Quen's tree never ran. The active GM is the one
     * client present for every exchange, so it holds the list, rebuilt from
     * the ward badges the world already carries (`wardRegistry.mjs`).
     *
     * Rebuilt on ready (so a reload no longer disarms everything in play) and
     * whenever a ward badge appears, changes or goes. Scoped to the one actor
     * whose badge moved, except at boot. */
    /* Hand the socket layer the function it should run, instead of it
     * importing this side on every request — that deadlocked, and it put four
     * module resolutions in the path of every warded attack. */
    setInterceptionRunner((data) => runHostInterception(data, foundryAdapter));

    if (isEngineHost()) {
        rebuildAllWards()
            .then(n => console.log(`${SYSTEM_ID} | ward bus rebuilt: ${n} subscription(s)`))
            .catch(err => console.warn(`${SYSTEM_ID} | ward rebuild failed`, err));
    }
    const wardBadgeMoved = (effect) => {
        if (!isEngineHost()) return;
        const f = effect?.flags?.[SYSTEM_ID];
        if (!f?.castShield && !f?.castWard) return;
        const owner = effect.parent;
        if (owner?.documentName !== "Actor") return;
        rebuildWardsFor(owner).catch(err =>
            console.warn(`${SYSTEM_ID} | ward rebuild failed for ${owner.name}`, err));
    };
    Hooks.on("createActiveEffect", wardBadgeMoved);
    Hooks.on("updateActiveEffect", wardBadgeMoved);
    Hooks.on("deleteActiveEffect", wardBadgeMoved);

    /* The GM's control for effects only a person can end, and the list of
     * everything currently standing. */
    installStandingHandler();
    game.witcher ??= {};
    game.witcher.magic = { ...(game.witcher.magic ?? {}), standing: openStandingPanel };

    /* One clock advance per round, on the GM's client only. Every client
     * running it would fire each per-round effect once per connected player. */
    Hooks.on("combatRound", async (combat, changed, options) => {
        if (!game.user.isActiveGM) return;
        /* The clocks fire first and the countdowns tick second — so anything
         * the clocks APPLY is wrapped, and skips the tick it was born in. */
        await duringTick("round", advanceMagicClocks);
        tick("round");
        /* And the maintained spells are PAID FOR. */
        await chargeUpkeep(combat);
        /* A new round is a new vigor budget. Without this the per-round chaos
         * counter is write-only and every caster slowly poisons themselves. */
        await clearChaos(combat);
    });

    /* Combat over — leave no per-round state stuck on the sheet. */
    Hooks.on("deleteCombat", async (combat) => {
        if (!game.user.isActiveGM) return;
        await clearChaos(combat);
    });

    /* Longer scales, for effects measured in hours or days. `simple-calendar`
     * style world-time changes rather than combat rounds. */
    Hooks.on("updateWorldTime", (worldTime, delta) => {
        if (!game.user.isActiveGM || !delta) return;
        const minutes = Math.floor(delta / 60);
        if (minutes) tick("minute", minutes);
        const hours = Math.floor(delta / 3600);
        if (hours) tick("hour", hours);
        const days = Math.floor(delta / 86400);
        if (days) tick("day", days);
    });

    /* An actor leaving play takes its magic with it. Without this a zone
     * created by a deleted token keeps catching people who walk through where
     * it used to be. */
    /* An effect this engine put on somebody can be removed by anyone — the
     * system's own turn-start sweep clears `staggered`, a GM can right-click it
     * off, another module can strip it. When that happens the engine's lifetime
     * for it is stale: it sits in LIVE believing it still holds, waiting for a
     * condition (a save, a zone exit) that no longer means anything, and it
     * never leaves.
     *
     * Found with Cursed Illness — the status was gone by round 2 while
     * `status:staggered` stayed in the live list for the rest of the session. */
    Hooks.on("deleteActiveEffect", (effect) => {
        const record = effect?.getFlag?.(SYSTEM_ID, "record");
        if (!record?.castId) return;
        const owner = effect.parent;
        endWhere(e => e.owner === owner
                   && e.record?.castId === record.castId
                   && String(e.kind ?? "").startsWith("status:"), "effectRemoved");
    });

    Hooks.on("deleteActor", (actor) => {
        cancelClocksFor(actor);
        endWhere(e => e.owner === actor, "actorDeleted");
    });

    /* ── The end conditions that nothing used to fire ──────────────────────
     *
     * Eight of the twenty `ENDS` were declared, offered in the authoring
     * dropdown, and produced by no code anywhere: an effect wearing one sat in
     * the live list forever while looking perfectly correct in the tree. The
     * worst of them immobilised its own caster (Sigil of the Hidden,
     * `untilDispelled`) with no way out in the whole system.
     *
     * Each one below is wired to the thing the book says ends it.
     */

    /* PUT OUT — the fire is out. The system's own `burning` carries a "Put Out
     * Fire" action that deletes the effect, and a Downpour removes the status;
     * either way the AE goes, and that IS the condition. The generic
     * effect-removed sweep above only covers lifetimes keyed `status:`, and
     * only ends them as "effectRemoved" — this names the real condition so an
     * `onExpire` tree can tell being doused from being dispelled. */
    Hooks.on("deleteActiveEffect", (effect) => {
        const owner = effect?.parent;
        if (!owner) return;
        const ids = new Set([...(effect.statuses ?? [])].map(String));
        if (![...ids].some(id => /burn|fire|alight/i.test(id))) return;
        for (const e of activeLifetimes(owner)) {
            if (e.conditions.includes(ENDS.UNTIL_PUT_OUT)) fireCondition(e, ENDS.UNTIL_PUT_OUT);
        }
    });

    /* CASTER STRUCK — "the suffocation ends if the caster is struck with a
     * weapon". Any drop in the caster's HP is a strike: the book's concern is
     * that concentration breaks, not which weapon did it. */
    Hooks.on("updateActor", (actor, changes) => {
        if (!game.user.isActiveGM) return;
        const hp = foundry.utils.getProperty(changes, "system.derivedStats.hp.value");
        if (hp == null) return;
        const before = Number(actor._source?.system?.derivedStats?.hp?.value);
        /* `updateActor` fires after the write, so compare against the value the
         * change carried rather than the actor's current one. */
        for (const e of activeLifetimes(actor)) {
            if (e.conditions.includes(ENDS.CASTER_STRUCK)) fireCondition(e, ENDS.CASTER_STRUCK);
        }
        void before;
    });

    /* DESTROYED — a conjured wall, spike or copy is broken.
     *
     * `untilDestroyed` used to be a GM's call for everything, because nothing
     * conjured existed on the map to break. Now that walls and summons are
     * real tokens, the commonest case answers itself: the thing hit 0 HP.
     * The GM's control remains for everything the map cannot decide. */
    Hooks.on("updateActor", async (actor, changes) => {
        if (!game.user.isActiveGM) return;
        const conjured = actor.getFlag?.(SYSTEM_ID, "conjured");
        if (!conjured) return;
        const hp = foundry.utils.getProperty(changes, "system.derivedStats.hp.value");
        if (hp == null || Number(hp) > 0) return;
        endDestroyed(null, conjured.castId ?? null);
        /* And it leaves the map — a shattered wall is not a 0 HP wall. */
        const { emitRemoveConjured } = await import("../setup/socketHook.mjs");
        emitRemoveConjured({ actorUuid: actor.uuid });
    });

    /* EXPENDED — a granted pool, spent a point at a time, is gone. Watches the
     * pool the sheet actually decrements. */
    Hooks.on("updateActor", (actor, changes) => {
        if (!game.user.isActiveGM) return;
        const luck = foundry.utils.getProperty(changes, "system.stats.luck.value");
        if (luck == null || Number(luck) > 0) return;
        for (const e of activeLifetimes(actor)) {
            if (e.conditions.includes(ENDS.UNTIL_EXPENDED)) fireCondition(e, ENDS.UNTIL_EXPENDED);
        }
    });

    /* WORLD EVENT — "until the next sunrise". A day boundary in world time is
     * the only sunrise this system knows about; a calendar module that names
     * them can call `endWorldEvent()` directly. */
    Hooks.on("updateWorldTime", (worldTime, delta) => {
        if (!game.user.isActiveGM || !delta) return;
        const dayLength = 86400;
        const crossed = Math.floor(worldTime / dayLength) !== Math.floor((worldTime - delta) / dayLength);
        if (crossed) endWorldEvent("sunrise");
    });

    /* Concentration. A maintained spell bars its caster from casting anything
     * else, and ends the moment the upkeep goes unpaid — both halves are the
     * frame's law, and this is where the second one meets the world. */
    Hooks.on("updateActor", async (actor, changes) => {
        if (!game.user.isActiveGM) return;
        const concentration = actor.getFlag(SYSTEM_ID, "concentration");
        if (!concentration) return;
        const sta = foundry.utils.getProperty(changes, "system.derivedStats.sta.value");
        if (sta == null || sta >= concentration.perRound) return;
        await actor.unsetFlag(SYSTEM_ID, "concentration");
        const castId = concentration?.record?.castId ?? null;
        endWhere(e => (e.owner === actor || (castId && e.record?.castId === castId))
                   && e.conditions.includes("upkeepUnpaid"), "upkeepUnpaid");
    });
}

/**
 * Charge every maintained spell its per-round Stamina, and end the ones that
 * cannot be paid for.
 *
 * "The mage must spend the required amount of STA every round to keep the
 * spell active." The frame opened the upkeep, wrote `perRound` onto a
 * concentration flag, printed "Maintained for 4 Stamina a round" on the cast
 * card — and nothing, anywhere, ever took the Stamina. Every maintained spell
 * in the game was free after the first round, and the only way one could end
 * was the caster's Stamina happening to fall below the upkeep for some
 * unrelated reason.
 *
 * Charged on the round tick, GM-side, for the same reason the clocks are: one
 * client must own it or five players each bill the caster.
 */
async function chargeUpkeep(combat) {
    const seen = new Set();
    for (const c of combat?.combatants ?? []) {
        const actor = c.actor;
        if (!actor || seen.has(actor.id)) continue;
        seen.add(actor.id);

        const held = actor.getFlag(SYSTEM_ID, "concentration");
        const per = Number(held?.perRound) || 0;
        if (!held || per <= 0) continue;

        const sta = Number(actor.system?.derivedStats?.sta?.value) || 0;
        if (sta < per) {
            /* Cannot pay: the spell ends now, on the round it lapsed. */
            await actor.unsetFlag(SYSTEM_ID, "concentration");
            /* Everything THAT CAST left standing, wherever it landed.
             *
             * Scoped by owner, this only ever lifted effects sitting on the
             * caster — so Telepathy's link on somebody else, and every marker
             * a maintained spell puts on its victims, outlived the spell that
             * was paying for them. The cast is the thing that ended, so the
             * cast's id is what to match on. */
            const castId = held?.record?.castId ?? null;
            endWhere(e => (e.owner === actor || (castId && e.record?.castId === castId))
                       && e.conditions.includes("upkeepUnpaid"), "upkeepUnpaid");
            cancelClocksFor(actor);
            globalThis.ui?.notifications?.info(game.i18n.format("WITCHER.Magic.UpkeepLapsed",
                { name: actor.name, sta: per }));
            continue;
        }
        try { await actor.update({ "system.derivedStats.sta.value": sta - per }); }
        catch (err) { console.warn(`${SYSTEM_ID} | upkeep charge failed`, err); }
    }
}

/** Wipe the per-round chaos counter for everyone in a combat. */
async function clearChaos(combat) {
    for (const c of combat?.combatants ?? []) {
        if (c.actor?.getFlag(SYSTEM_ID, "chaosThisRound") != null) {
            await c.actor.unsetFlag(SYSTEM_ID, "chaosThisRound");
        }
    }
}
