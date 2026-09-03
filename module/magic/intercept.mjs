/**
 * Interception — running a subscription's tree.
 *
 * A cast context and an interception context are not the same shape, and
 * pretending otherwise is how the old engine ended up applying status riders
 * through three divergent loops. A cast has `targets`; an interception has
 * `incoming` (the mutable payload passing through) and `state` (the
 * subscribing effect's own data).
 *
 * What they share is the block vocabulary, which is the point: `applyStatus`
 * behaves identically whether it fires from a cast's `hit` tree or a shield's
 * `takeDamage` tree.
 */

import { publish, unsubscribe, ENTRY } from "./bus.mjs";
import { runBody } from "./frame.mjs";
import { isEngineHost } from "./wardRegistry.mjs";

/**
 * Interception happens on the ENGINE HOST, not on whoever is attacking.
 *
 * The subscription list is a module-level array, so it exists per browser, and
 * the browser that raised a ward is never the browser that resolves the attack
 * against it. The host — the active GM — is the one client present for every
 * exchange, so it holds the list (rebuilt from the ward badges, see
 * `wardRegistry.mjs`) and answers on the defender's behalf.
 *
 * `hostIntercept` is the hop. On the host it runs `local` directly; anywhere
 * else it asks the host over the socket and returns what came back. A host that
 * cannot be reached, or that errors, resolves to `null` and the caller carries
 * on as though no ward existed — a ward that fails to fire must never eat the
 * attack it was supposed to stop.
 */
function canReachHost() {
    const g = globalThis.game;
    return !!g?.socket && !!g?.users?.find?.(u => u.isGM && u.active);
}

async function hostIntercept(kind, request, local) {
    /* Run it here when this client IS the host, and ALSO when there is no host
     * to ask — a solo game, a world with no GM logged in, or the unit suites.
     * Falling back to local is what preserves the old single-client behaviour
     * instead of quietly turning every ward off; the hop is an improvement on
     * that case, not a replacement for it. */
    if (isEngineHost() || !canReachHost()) return local();
    try {
        const { requestInterception } = await import("../setup/socketHook.mjs");
        const verdict = await requestInterception({ kind, ...request });
        return verdict ?? null;
    } catch (err) {
        console.warn("magic | interception request failed", err);
        return null;
    }
}

/** Build the context a subscription's tree runs in. */
export function makeInterceptContext(sub, payload, adapter) {
    return {
        owner:   sub.owner,
        actor:   sub.owner,
        adapter,
        state:   sub.state,          // the effect's own mutable data
        record:  sub.record,         // the record of the cast that CREATED this effect
        incoming: payload,           // the cast/damage currently passing through
        source:  sub.source,

        /* Blocks that iterate targets treat the protected actor as the only
         * one, so shared blocks keep working unchanged. */
        targets: [{ actor: sub.owner, hit: true, defenceTotal: null, margin: null }],

        vars:    { sta: 0, margin: 0, skill: 0, index: 0, vigor: 0 },
        control: { aborted: false },
        created: [],

        /* Lets a block tear its own subscription down — an emptied Quen pool,
         * a spent ward charge. */
        expire: () => unsubscribe(sub)
    };
}

async function runOne(sub, payload, adapter) {
    const ctx = makeInterceptContext(sub, payload, adapter);
    await runBody(sub.tree, ctx);
    return ctx;
}

/**
 * Damage application, routed through interception.
 *
 * Order matters and is load-bearing: subscribers run BEFORE the damage
 * reaches the actor, because Quen absorbs ahead of armour and only the
 * overflow "must penetrate your armor and damage resistances just like any
 * other attack".
 */
export async function applyDamageWithInterception(target, amount, opts, adapter) {
    const payload = {
        target,
        amount,
        absorbed: 0,
        record: opts?.record ?? { defenceSet: [], damageChannel: "attack" },
        damageType: opts?.damageType ?? "physical",
        /* Wards read this to decide whether they stop it. Absent, every ward
         * that only stops lethal damage stopped everything. */
        nonLethal: !!opts?.nonLethal
    };

    const verdict = await hostIntercept("takeDamage", {
        targetUuid: target?.uuid ?? null,
        amount, record: payload.record,
        damageType: payload.damageType, nonLethal: payload.nonLethal
    }, async () => {
        await publish(ENTRY.TAKE_DAMAGE, {
            owner: target,
            payload,
            runTree: (sub, p) => runOne(sub, p, adapter)
        });
        return { amount: payload.amount, absorbed: payload.absorbed,
                 shieldBroke: !!payload.shieldBroke };
    });
    /* Fold the host's answer back into the local payload. Only the fields a
     * ward is allowed to change come across — the rest of the payload is the
     * attacker's own and must not be rewritten by the defender's client. */
    if (verdict) {
        payload.amount      = Number.isFinite(verdict.amount) ? verdict.amount : payload.amount;
        payload.absorbed    = Number(verdict.absorbed) || 0;
        payload.shieldBroke = !!verdict.shieldBroke;
    }

    if (payload.amount > 0) {
        const applied = await adapter.applyDamage(target, payload.amount,
            { ...opts, afterAbsorption: payload.absorbed > 0 });
        payload.penetrated = applied?.penetrated ?? null;
        payload.finalDamage = applied?.finalDamage ?? null;
    }
    return payload;
}

/**
 * A cast passing the defender's magic interception — Heliotrope, Dispel as a
 * reaction, Demetia's Crest Surge. Publishes before the opposed step so a
 * subscriber can veto the cast outright, which is what `Defense: None` magic
 * requires: the rules say it "cannot be defended against UNLESS the Dispel
 * spell or Heliotrope sign is used", and those are the only two things that
 * can reach it.
 */
export async function offerMagicInterception(target, castRecord, adapter) {
    const payload = { target, record: castRecord, vetoed: false };
    const verdict = await hostIntercept("incomingMagic", {
        targetUuid: target?.uuid ?? null, record: castRecord
    }, async () => {
        await publish(ENTRY.INCOMING_MAGIC, {
            owner: target,
            payload,
            runTree: (sub, p) => runOne(sub, p, adapter)
        });
        return { vetoed: !!payload.vetoed };
    });
    if (verdict) payload.vetoed = !!verdict.vetoed;
    return payload;
}


/**
 * A physical attack arriving at somebody who has a ward up.
 *
 * `ENTRY.INCOMING_ATTACK` was declared, offered in the authoring dropdown, and
 * published by nothing anywhere — so Gwynt Troelli, whose ENTIRE spell is
 * "any projectile attack must beat your Spell Casting roll or be deflected",
 * posted a card announcing a barrier of wind and gave the world nothing. The
 * same half of Dervish was dead for the same reason.
 *
 * Published from the damage handler, which is the one place every attack in
 * the system passes through — a sword, a bolt, a bomb, a claw. Deflection only:
 * absorption belongs to the shield pool the damage calculator already drains,
 * and running both would soak the same points twice.
 */
export async function offerAttackInterception(target, incoming, adapter) {
    const payload = { target, deflected: false, ...incoming };
    await publish(ENTRY.INCOMING_ATTACK, {
        owner: target,
        payload,
        runTree: (sub, p) => runOne(sub, p, adapter)
    });
    return payload;
}

/**
 * Run an interception request on the host, on the defender's behalf.
 *
 * Registered with the socket layer at `ready` (see `register.mjs`) rather than
 * imported by it — the socket file sits on the other side of this module graph,
 * and resolving these modules from inside its handler deadlocked.
 *
 * The adapter is built for the DEFENDER: every write a ward makes — spending a
 * charge, draining a pool — is a write to the defender's own actor, and
 * building it for the attacker is what put those writes across a permission
 * boundary where they were silently dropped.
 *
 * Returns only the fields a ward is entitled to change. Anything else about the
 * attack belongs to the attacker and must not come back rewritten.
 */
export async function runHostInterception(data, makeAdapter) {
    const target = await fromUuid(data?.targetUuid);
    const actor  = target?.actor ?? target;
    if (!actor) return null;
    /* The factory is passed IN, not imported: `adapter.mjs` cannot be loaded
     * outside Foundry, and this module is exercised by the unit suites. */
    const adapter = makeAdapter?.(actor);
    if (!adapter) return null;
    const runTree = (sub, p) => runOne(sub, p, adapter);

    if (data.kind === "incomingMagic") {
        const payload = { target: actor, record: data.record ?? {}, vetoed: false };
        await publish(ENTRY.INCOMING_MAGIC, { owner: actor, payload, runTree });
        return { vetoed: !!payload.vetoed };
    }
    if (data.kind === "takeDamage") {
        const payload = {
            target: actor,
            amount: Number(data.amount) || 0,
            absorbed: 0,
            record: data.record ?? { defenceSet: [], damageChannel: "attack" },
            damageType: data.damageType ?? "physical",
            nonLethal: !!data.nonLethal
        };
        await publish(ENTRY.TAKE_DAMAGE, { owner: actor, payload, runTree });
        return { amount: payload.amount, absorbed: payload.absorbed,
                 shieldBroke: !!payload.shieldBroke };
    }
    return null;
}
