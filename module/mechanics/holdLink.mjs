/**
 * Hold-link bookkeeping — Clinch / Grapple / Pin / Chokehold.
 *
 * Model (revised for bidirectional + multi-clinch):
 *   - BOTH parties in a hold pair carry the status. If A clinches B,
 *     A and B both have `clinched`. Consequences: Close Quarters
 *     fires for anyone attacking either side; the token HUD shows
 *     the icon on both.
 *   - A single actor can be in MANY pairs. B clinched by A, C, and D
 *     = three separate pairs. Cleanup of one pair does NOT clear the
 *     status on B unless B has no other pairs of the same kind.
 *   - Escape is pure movement: no roll. If either side is more than
 *     the reach threshold from the other on any token update, that
 *     pair breaks (only that pair — other pairs the actors are in
 *     stay intact).
 *
 * Storage lives on the hidden GM-only registry actor (holdRegistry.mjs).
 * Each pair is one entry: { holderUuid, targetUuid, kind }.
 *
 * Break triggers:
 *   1. Movement — either side moves beyond reach.
 *   2. Incapacitation — prone / stunned / unconscious / dead.
 *   3. Actor deletion — cascades to remove every pair touching the
 *      deleted uuid.
 *
 * `HOLD_STATUSES` is the shared list of hold-status ids — same one
 * openCategoryBonuses.contextFires reads to fire Close Quarters.
 */

const SYSTEM_ID = "witcher-ttrpg-death-march";

/** Hold-status ids managed by this module. */
export const HOLD_STATUSES = Object.freeze(["grappled", "pinned", "clinched", "chokeheld", "mounted"]);

/** Combat-Extended-only visible holder-side counterparts.
 *  Stamped on the HOLDER of a hold pair when CE is on so the token
 *  HUD shows who is currently holding whom. Zero mods live in the
 *  clauses — the -2 / -3 penalty comes from the runtime carve-out
 *  in mechanics/holdModifiers.contextualPhysicalMod (which knows to
 *  skip the penalty when the roll target is the actor's partner).
 *  Ride uses this same pattern: `isMounted` on the rider (which
 *  restricts movement) and `mounted` on the mount (visible only). */
const HOLDER_STATUS_BY_KIND = Object.freeze({
    grappled:  "isGrappling",
    pinned:    "isPinning",
    chokeheld: "isChoking",
    mounted:   "isMounted"   // for ride, the "rider" is the target of the pair
});

/** Reads the CE master toggle at call time (not import time) so a mid-
 *  session GM flip flows through the next apply/clear without a reload.
 *  Falls back to false if settings aren't ready — RAW-only behavior is
 *  the safe default. */
function isCEOn() {
    try {
        // Deferred require to dodge init-order circularity with the
        // homebrew API surface.
        // eslint-disable-next-line global-require
        const { isHomebrewEnabled } = require?.("../api/homebrew.mjs") ?? {};
        if (typeof isHomebrewEnabled === "function") return isHomebrewEnabled("extendedCombat") === true;
    } catch (_) { /* CommonJS not available — ESM path below */ }
    // ESM path — read the setting directly.
    try { return game?.settings?.get?.(SYSTEM_ID, "homebrew.extendedCombat") === true; }
    catch (_) { return false; }
}

/** Statuses that incapacitate a hold-linked actor enough to break
 *  every hold they're in. RAW: prone (you can't hold someone
 *  standing up), stunned (you can't actively maintain), unconscious
 *  / dead (obvious). */
const HOLD_BREAK_STATUSES = Object.freeze(["prone", "stunned", "unconscious", "dead"]);

/** Reach threshold in GRID TILES (Chebyshev). Adjacent (including
 *  diagonal) = 1 tile ⇒ still in reach. 2+ tiles ⇒ broken. Using
 *  Chebyshev (max of dx/dy in tiles) treats diagonal adjacency the
 *  same as orthogonal — a token one square diagonally away is
 *  still "adjacent" and still clinched. */
const HOLD_REACH_TILES = 1;

/** Token center on the canvas, or null if the actor has no active
 *  token. */
function actorTokenCenter(actor) {
    const tok = actor?.getActiveTokens?.()?.[0];
    if (!tok) return null;
    return { x: tok.center?.x ?? tok.x ?? 0, y: tok.center?.y ?? tok.y ?? 0 };
}

/** Normalize an actor to the uuid we key the registry with.
 *
 *  Bug this fixes: a targeted token in Foundry gives you the SYNTHETIC
 *  actor whose uuid is "Scene.X.Token.Y.Actor.Z", while the movement
 *  hook resolves through `game.actors.get(tokenDoc.actorId)` and reads
 *  the WORLD actor whose uuid is just "Actor.Z". Same underlying
 *  actor, different uuid strings ⇒ the registry lookup missed and the
 *  clinch never broke on move.
 *
 *  Fix: always store and look up by the WORLD actor's uuid. Synthetic
 *  actors expose `actor.token.actorId`; game.actors.get(...) gives us
 *  the world actor and its stable uuid. Linked actors fall through to
 *  their own uuid, which is already the world one. */
function normalizedActorUuid(actor) {
    if (!actor) return null;
    const tokenActorId = actor?.token?.actorId ?? null;
    if (tokenActorId) {
        const world = game?.actors?.get?.(tokenActorId);
        if (world?.uuid) return world.uuid;
    }
    return actor.uuid ?? null;
}

/** Public re-export so other mixins (weaponAttackMixin's Close-Quarters
 *  predicate, brawlMixin's needsGrapple check) can normalize their
 *  actor uuids the same way this module's writes/reads do. Comparing
 *  a raw synthetic-token uuid against a stored world-uuid pair silently
 *  fails; this helper keeps the two representations aligned. */
export { normalizedActorUuid };

/** Public re-export of the adjacency check. brawlMixin needs to gate
 *  the brawl attack ON THE FRONT END — before the roll, before any
 *  action-slot spend — so a player who's out of reach can't waste a
 *  turn discovering it after the dice. Called from brawlAttack right
 *  after target resolution. */
export { areActorsAdjacent };

/** Chebyshev distance in grid tiles between two canvas points.
 *  Diagonal-adjacent = 1 tile (matches Foundry's grid-adjacency for
 *  melee). Returns Infinity if the scene has no grid. */
function pixelChebyshevTiles(dx, dy) {
    const gridSize = Number(canvas?.scene?.grid?.size) || 0;
    if (gridSize <= 0) return Infinity;
    return Math.max(Math.abs(dx), Math.abs(dy)) / gridSize;
}

/** Are the two actors' active tokens adjacent on the canvas?
 *  Returns:
 *    true   — both tokens exist and are within HOLD_REACH_TILES.
 *    false  — both tokens exist but are farther apart.
 *    null   — one or both tokens are missing (theatre-of-mind case).
 *             Caller decides how to handle (usually prompt). */
function areActorsAdjacent(a, b) {
    const ac = actorTokenCenter(a);
    const bc = actorTokenCenter(b);
    if (!ac || !bc) return null;
    return pixelChebyshevTiles(ac.x - bc.x, ac.y - bc.y) <= HOLD_REACH_TILES;
}

/** Prompt the initiator "Is the target adjacent?" when neither side
 *  has a canvas token to measure. Returns true if the user confirms.
 *  Falls back to `true` when Foundry's Dialog isn't available (e.g.
 *  GM-macro contexts running before UI is ready) — better to allow
 *  the clinch than to silently drop it. */
async function promptAdjacency(holderName, targetName) {
    const DialogV2 = foundry?.applications?.api?.DialogV2;
    if (!DialogV2) return true;
    try {
        return !!(await DialogV2.confirm({
            window: { title: game.i18n?.localize?.("WITCHER.Clinch.Adjacent.Title") || "Clinch — Adjacency Check" },
            content: `<p>No tokens on canvas for this clinch. Is <strong>${holderName}</strong> adjacent to <strong>${targetName}</strong>?</p>`
        }));
    } catch (_) {
        return true;
    }
}

/** Read all hold pairs an actor is currently in. Returns an array of
 *  legacy-shape entries `{ uuid, partnerUuid, kind, role }` for
 *  each pair. Normalizes synthetic-token actors to their world-uuid
 *  so a lookup from either representation of the same actor works. */
export async function getHoldLinks(actor) {
    const uuid = normalizedActorUuid(actor);
    if (!uuid) return [];
    const { getHolds } = await import("./holdRegistry.mjs");
    const pairs = await getHolds(uuid);
    return pairs.map(p => _toLegacy(p, uuid));
}

/** Back-compat single-pair reader. Returns the first pair the actor
 *  is in, or null if none. Prefer getHoldLinks in new code. */
export async function getHoldLink(actor) {
    const uuid = normalizedActorUuid(actor);
    if (!uuid) return null;
    const { getHold } = await import("./holdRegistry.mjs");
    return getHold(uuid);
}

function _toLegacy(pair, actorUuid) {
    if (pair.holderUuid === actorUuid) {
        return { uuid: pair.holderUuid, partnerUuid: pair.targetUuid, kind: pair.kind, role: "holder" };
    }
    return { uuid: pair.targetUuid, partnerUuid: pair.holderUuid, kind: pair.kind, role: "target" };
}

/** GM-side: perform the writes for a new pair.
 *
 *  Bidirectional status: both holder AND target get the `kind`
 *  status stamped. That's the whole point — you're in the clinch too.
 *
 *  Multi-clinch: setHold appends the pair rather than overwriting,
 *  so a target already clinched by someone else gets a NEW pair
 *  without losing the existing ones. Idempotent for exact duplicates.
 */
async function _doApplyHoldLink(holder, target, kind) {
    if (!holder || !target || holder === target) return false;
    if (!HOLD_STATUSES.includes(kind)) return false;
    /* Refuse to apply if the holder is incapacitated — a stunned /
     * prone / dead actor can't initiate a hold. */
    for (const s of HOLD_BREAK_STATUSES) {
        if (holder.statuses?.has?.(s)) return false;
    }
    /* Stamp the status on the TARGET only.
     *
     * RAW Core "Brawling & Wrestling" describes the grappled TARGET's
     * penalties (−2 to all physical actions, can't move away) but says
     * nothing about the grappler's own state — the grappler isn't
     * grappled by their own hold. Stamping the status on both sides
     * (the old model) was making the grappler take −2 to attack, which
     * doesn't match RAW.
     *
     * The pair is still bidirectional in the REGISTRY (both actors can
     * look up their hold via getHolds), so downstream logic that needs
     * to know who holds whom still works. But only the target's status
     * bar shows the effect. Clinch (the CE-only softer variant) follows
     * the same shape for consistency — the aggressor isn't clinched by
     * their own move. */
    try { await target.toggleStatusEffect(kind, { active: true }); }
    catch (err) { console.warn(`${SYSTEM_ID} | hold status apply failed`, err); }
    /* Chokehold rider (RAW Core "Brawling & Wrestling"): "the opponent
     * is suffocating until they are able to escape." Co-apply the
     * suffocation status alongside chokeheld so the per-turn DoT (3 dmg
     * bypassing armor) actually fires. When the pair is cleared via the
     * Escape action, _doClearHoldLink strips both. */
    if (kind === "chokeheld") {
        try { await target.toggleStatusEffect("suffocation", { active: true }); }
        catch (err) { console.warn(`${SYSTEM_ID} | suffocation apply failed`, err); }
    }
    /* Holder-side status stamp.
     *
     *   grappled → isGrappling stamps in BOTH RAW and CE. Core p.161 says
     *   the grappler cannot move away from the grappled target without
     *   releasing the hold — that lock lives on isGrappling's restrict.move
     *   clause. The −2 damage-side carve-out is CE-only and enforced by
     *   contextualPhysicalMod itself (which returns 0 under RAW), so we
     *   don't need a CE gate here to keep the RAW roll math clean.
     *
     *   pinned/chokeheld/mounted → CE-only visual/movement flourishes
     *   (isPinning carries the pinner's move-lock; isMounted carries the
     *   rider's; isChoking is visible-only). RAW leaves these holder-side
     *   slots empty. */
    const holderSid = HOLDER_STATUS_BY_KIND[kind];
    if (holderSid && (kind === "grappled" || isCEOn())) {
        try { await holder.toggleStatusEffect(holderSid, { active: true }); }
        catch (err) { console.warn(`${SYSTEM_ID} | holder-side status apply failed`, err); }
    }
    /* Normalize to WORLD actor uuids so the registry and the movement
     * hook agree — synthetic-token uuids would otherwise slip past
     * getHolds(actorFromWorld.uuid). */
    const holderUuid = normalizedActorUuid(holder);
    const targetUuid = normalizedActorUuid(target);
    if (!holderUuid || !targetUuid) return false;
    const { setHold } = await import("./holdRegistry.mjs");
    const wasNew = await setHold(holderUuid, targetUuid, kind);
    /* Announce every new hold in chat with a clear "holder → target"
     * card so the whole table can see who is the DOMINANT one and who
     * is HELD. Duplicates (setHold returning false) don't re-announce.
     * Also lists follow-up actions available to the holder — Pin,
     * Choke, Throw — so the player doesn't have to hunt for them.
     * Best-effort: a failed ChatMessage.create doesn't abort the
     * pair storage. */
    if (wasNew && ChatMessage?.create) {
        const emoji = kind === "chokeheld" ? "🫁"
                    : kind === "pinned"    ? "🪤"
                    : kind === "clinched"  ? "🤝"
                    : "🤼";
        const kindLabel = kind === "chokeheld" ? "Choke-holds"
                        : kind === "pinned"    ? "pins"
                        : kind === "clinched"  ? "clinches"
                        : "grapples";
        const followUps = kind === "grappled"
            ? '<div class="wdm-attack-note" style="margin-top:6px;"><i class="fa-solid fa-arrow-right"></i> <strong>' +
              (holder?.name ?? "Holder") + '</strong> can now attempt <em>Pin</em>, <em>Choke</em>, or <em>Throw</em> against <strong>' +
              (target?.name ?? "Target") + '</strong>. Target can spend an Action for <em>Escape</em> (Dodge/Escape vs Brawling).</div>'
            : kind === "pinned" || kind === "chokeheld"
                ? '<div class="wdm-attack-note" style="margin-top:6px;"><i class="fa-solid fa-arrow-right"></i> Target can spend an Action for <em>Escape</em> (Dodge/Escape vs Brawling).</div>'
                : "";
        try {
            await ChatMessage.create({
                content:
                    '<div class="wdm-attack-rider" style="border-left:3px solid #b98;padding-left:6px;">' +
                        `${emoji} <strong>${(holder?.name ?? "Holder")}</strong> ${kindLabel} <strong>${(target?.name ?? "Target")}</strong>.` +
                    '</div>' + followUps
            });
        } catch (_) { /* best-effort */ }
    }
    return true;
}

/** Apply a hold: stamp matching status on BOTH actors + append pair
 *  to registry. Idempotent on exact-duplicate applies. Multi-target
 *  clinch: multiple holders can clinch one target — each apply
 *  creates a separate pair.
 *
 *  Adjacency gate: the initiator must be adjacent (Chebyshev ≤ 1
 *  tile) to the target. When both actors have tokens, distance is
 *  measured directly. When either lacks a token (theatre-of-mind /
 *  combat-tracker target), the initiator's client shows a Dialog
 *  asking whether they're adjacent — the check runs on the caller's
 *  client BEFORE socket-routing so the prompt lands on the right
 *  user's screen.
 *
 *  Permission routing: a player Clinching a GM-owned NPC can't write
 *  to the NPC directly. Non-GM callers always route through the
 *  socket. */
export async function applyHoldLink(holder, target, kind) {
    if (!holder || !target || holder === target) return false;
    if (!HOLD_STATUSES.includes(kind)) return false;
    /* Adjacency gate — runs on the initiator's client so the prompt
     * (if any) shows to the correct user. brawlMixin also runs this
     * check UPSTREAM (before the roll + resource spend) so the failure
     * lands as an actionable prompt, not a wasted turn. This inner
     * check stays as a safety net for any caller that skips the
     * upstream gate. */
    const adj = areActorsAdjacent(holder, target);
    if (adj === false) {
        try {
            const hName = holder?.name ?? "Holder";
            const tName = target?.name ?? "target";
            const msg = game.i18n?.format?.("WITCHER.Clinch.NotAdjacent",
                { holder: hName, target: tName })
                || `${hName} isn't within reach of ${tName} — step adjacent (within 1 tile) before brawling.`;
            ui?.notifications?.warn?.(msg);
        } catch (_) { /* ignore */ }
        return false;
    }
    if (adj === null) {
        const ok = await promptAdjacency(holder?.name ?? "Holder", target?.name ?? "Target");
        if (!ok) return false;
    }
    if (game.user?.isActiveGM) return _doApplyHoldLink(holder, target, kind);
    try {
        game.socket?.emit(`system.${SYSTEM_ID}`, {
            type: "holdApply",
            holderUuid: holder.uuid,
            targetUuid: target.uuid,
            kind,
            senderUserId: game.user?.id
        });
        return true;
    } catch (err) {
        console.warn(`${SYSTEM_ID} | holdApply socket emit failed`, err);
        return false;
    }
}
export { _doApplyHoldLink };

/** GM-side: perform the clears.
 *
 *  Two modes:
 *    - Cascade (no partner given): clear every pair the actor is in.
 *      Used by deletion sweeps + incapacitation clears.
 *    - Targeted (partner given): clear just the pair between actor
 *      and that specific partner. Used by movement break — A steps
 *      off B, only the A↔B pair breaks; if B is also clinched by C
 *      and D, those pairs stay.
 *
 *  Status stripping rule: for each pair removed, check whether each
 *  side still has ANOTHER pair of the same kind. If yes, keep the
 *  status. If no, remove it. Handles the multi-clinch case cleanly
 *  — a target clinched by 3 holders keeps `clinched` until the last
 *  holder walks away. */
async function _doClearHoldLink(actor, reason, partnerActor = null) {
    if (!actor) return false;
    const actorUuid = normalizedActorUuid(actor);
    if (!actorUuid) return false;
    const { clearHold, getHolds } = await import("./holdRegistry.mjs");
    const removed = await clearHold(actorUuid, normalizedActorUuid(partnerActor));
    if (!removed || removed.length === 0) return false;
    /* Gather every uuid whose pair was removed. */
    const affectedUuids = new Set();
    for (const p of removed) {
        affectedUuids.add(p.holderUuid);
        affectedUuids.add(p.targetUuid);
    }
    /* For each affected actor, check remaining pairs. If they have
     * no pair of a given kind anymore, strip that status.
     *
     * Status-representation trap: pairs are stored under the WORLD
     * actor's uuid (normalized). But if the clinch was applied to a
     * synthetic-token actor (unlinked token), the `clinched` status
     * lives on that synthetic actor's `.statuses`, NOT on the world
     * actor's. Toggling only the world actor would leave the status
     * icon visible on the token forever.
     *
     * Fix: for each affected world uuid, gather EVERY representation
     * — the world actor itself PLUS any token on the canvas whose
     * actorId matches. Toggle the status off on all of them. This is
     * O(pairs × canvas-tokens) but n is tiny in practice. */
    for (const uuid of affectedUuids) {
        const remaining = await getHolds(uuid);
        const remainingKinds = new Set(remaining.map(p => p.kind));
        /* Find the kinds this actor USED to hold that are now gone. */
        const removedKindsForActor = new Set(
            removed
                .filter(p => p.holderUuid === uuid || p.targetUuid === uuid)
                .map(p => p.kind)
        );
        const kindsToStrip = [...removedKindsForActor].filter(k => !remainingKinds.has(k));
        /* Holder-side statuses to strip. Symmetric to the apply side:
         *   - `grappled → isGrappling` is stamped in BOTH RAW and CE, so
         *     we always compute strip for it.
         *   - `pinned/chokeheld/mounted` holder-side flourishes are
         *     CE-only, so they only need stripping when CE is on.
         *
         * Independent of the target-side kindsToStrip: a grappler who
         * releases one victim but still holds another keeps
         * `isGrappling`; a grappler who releases their last victim loses
         * it even if they're still someone else's TARGET for a different
         * kind. */
        const ceOn = isCEOn();
        const holderSidsToStrip = (() => {
            const removedHolderKinds = new Set(
                removed.filter(p => p.holderUuid === uuid).map(p => p.kind)
            );
            const remainingHolderKinds = new Set(
                remaining.filter(p => p.holderUuid === uuid).map(p => p.kind)
            );
            return [...removedHolderKinds]
                .filter(k => !remainingHolderKinds.has(k))
                .filter(k => k === "grappled" || ceOn)
                .map(k => HOLDER_STATUS_BY_KIND[k])
                .filter(Boolean);
        })();
        if (kindsToStrip.length === 0 && holderSidsToStrip.length === 0) continue;
        const representations = new Set();
        const worldSide = await fromUuid(uuid);
        if (worldSide) representations.add(worldSide);
        /* Synthetic-token actors — every token on the canvas whose
         * base actorId matches this world uuid may carry an
         * independent copy of the status. */
        const worldActorId = worldSide?.id ?? null;
        const tokens = canvas?.tokens?.placeables ?? [];
        for (const t of tokens) {
            if (worldActorId && t?.document?.actorId === worldActorId && t.actor) {
                representations.add(t.actor);
            }
        }
        for (const side of representations) {
            if (!side?.toggleStatusEffect) continue;
            for (const sid of kindsToStrip) {
                if (side.statuses?.has?.(sid)) {
                    try { await side.toggleStatusEffect(sid, { active: false }); }
                    catch (_) { /* ignore */ }
                }
                /* Chokehold rider (RAW Core "Brawling & Wrestling"):
                 * "the opponent is suffocating until they are able to
                 * escape." The suffocation status was co-applied when
                 * the chokeheld pair was created; strip it now so the
                 * DoT stops the moment air is restored. Guarded on
                 * `chokeheld` kind — clearing a `grappled`/`clinched`/
                 * `pinned` pair does not touch suffocation. */
                if (sid === "chokeheld" && side.statuses?.has?.("suffocation")) {
                    try { await side.toggleStatusEffect("suffocation", { active: false }); }
                    catch (_) { /* ignore */ }
                }
            }
            /* CE holder-side visible indicators — strip only from
             * representations whose actor was the holder in a removed
             * pair that has no remaining holder-role pair of the same
             * kind. `holderSidsToStrip` was computed once above from
             * the world uuid, so it's the same list for every
             * representation of this actor. */
            for (const holderSid of holderSidsToStrip) {
                if (side.statuses?.has?.(holderSid)) {
                    try { await side.toggleStatusEffect(holderSid, { active: false }); }
                    catch (_) { /* ignore */ }
                }
            }
            /* Legacy actor-flag cleanup — pre-migration data. */
            try { await side.unsetFlag(SYSTEM_ID, "holdLink"); }
            catch (_) { /* ignore */ }
        }
    }
    /* Chat note per removed pair. */
    if (reason !== "manual" && ChatMessage?.create) {
        for (const pair of removed) {
            try {
                const holder  = await fromUuid(pair.holderUuid);
                const target  = await fromUuid(pair.targetUuid);
                const hName = holder?.name ?? "Actor";
                const tName = target?.name ?? "partner";
                const msg = {
                    content:
                        `<div class="wdm-attack-rider"><i class="fa-solid fa-link-slash"></i> ` +
                        `<strong>${hName}</strong> and <strong>${tName}</strong> break their ${pair.kind} ` +
                        `(${reason}).</div>`,
                    speaker: ChatMessage.getSpeaker?.({ actor })
                };
                await ChatMessage.create(msg);
            } catch (_) { /* best-effort */ }
        }
    }
    return true;
}
export { _doClearHoldLink };

/** Reverse dominance on the actor↔partner pair of the given kind.
 *
 *  Semantics: the actor is currently the TARGET of a hold pair
 *  (holder=partner, target=actor). On a successful reversal, we
 *  swap: new pair is (holder=actor, target=partner). Statuses move
 *  with the swap — old holder loses `is<Kind>ing`, gains `<kind>`;
 *  old target loses `<kind>`, gains `is<Kind>ing`.
 *
 *  CE-only. RAW has no reversal mechanic — the target's only path
 *  out of a hold is Escape (Dodge/Escape vs Brawling).
 *
 *  Non-GM callers route through the socket. */
export async function reverseHold(actor, partner, kind) {
    if (!actor || !partner || actor === partner) return false;
    if (!HOLD_STATUSES.includes(kind)) return false;
    if (!isCEOn()) return false;
    if (game.user?.isActiveGM) return _doReverseHold(actor, partner, kind);
    try {
        game.socket?.emit(`system.${SYSTEM_ID}`, {
            type: "holdReverse",
            actorUuid: actor.uuid,
            partnerUuid: partner.uuid,
            kind,
            senderUserId: game.user?.id
        });
        return true;
    } catch (err) {
        console.warn(`${SYSTEM_ID} | holdReverse socket emit failed`, err);
        return false;
    }
}

/** GM-side: perform the pair swap + status migration. */
async function _doReverseHold(newHolder, newTarget, kind) {
    const oldHolderUuid = normalizedActorUuid(newTarget);   // pre-swap holder = post-swap target
    const oldTargetUuid = normalizedActorUuid(newHolder);   // pre-swap target = post-swap holder
    if (!oldHolderUuid || !oldTargetUuid) return false;
    const { reversePair } = await import("./holdRegistry.mjs");
    const swapped = await reversePair(oldHolderUuid, oldTargetUuid, kind);
    if (!swapped) return false;
    /* Migrate statuses.
     *
     * Old holder → becomes new target:
     *   strip holder-side visible status (isGrappling / etc.);
     *   stamp target-side status (grappled / etc.).
     * Old target → becomes new holder:
     *   strip target-side status;
     *   stamp holder-side visible status.
     *
     * The multi-hold trap: if the actor is still holder in ANOTHER
     * pair of the same kind after the swap, they keep the holder-
     * side status. Same for target-side. Compute what's still
     * present before stripping. */
    const { getHolds } = await import("./holdRegistry.mjs");
    const oldHolderRemaining = await getHolds(oldHolderUuid);
    const oldHolderStillHolds = oldHolderRemaining.some(p =>
        p.holderUuid === oldHolderUuid && p.kind === kind);
    const oldHolderStillTarget = oldHolderRemaining.some(p =>
        p.targetUuid === oldHolderUuid && p.kind === kind);
    const oldTargetRemaining = await getHolds(oldTargetUuid);
    const oldTargetStillHolds = oldTargetRemaining.some(p =>
        p.holderUuid === oldTargetUuid && p.kind === kind);
    const oldTargetStillTarget = oldTargetRemaining.some(p =>
        p.targetUuid === oldTargetUuid && p.kind === kind);
    const holderSid = HOLDER_STATUS_BY_KIND[kind];
    /* newTarget (old holder): strip holder-side status if none left. */
    if (holderSid && !oldHolderStillHolds && newTarget.statuses?.has?.(holderSid)) {
        try { await newTarget.toggleStatusEffect(holderSid, { active: false }); }
        catch (_) { /* ignore */ }
    }
    /* newTarget (old holder): stamp target-side status. Idempotent —
     * toggleStatusEffect with active:true on an already-present status
     * is a no-op. */
    try { await newTarget.toggleStatusEffect(kind, { active: true }); }
    catch (_) { /* ignore */ }
    /* newHolder (old target): strip target-side status if none left. */
    if (!oldTargetStillTarget && newHolder.statuses?.has?.(kind)) {
        try { await newHolder.toggleStatusEffect(kind, { active: false }); }
        catch (_) { /* ignore */ }
    }
    /* newHolder (old target): stamp holder-side status. */
    if (holderSid) {
        try { await newHolder.toggleStatusEffect(holderSid, { active: true }); }
        catch (_) { /* ignore */ }
    }
    /* Silence the unused-vars linter — `oldHolderStillTarget` /
     * `oldTargetStillHolds` are computed for possible future symmetric
     * checks (e.g. if a bidirectional CE kind adds mid-air). Cheap
     * getter reads, worth keeping the completeness. */
    void oldHolderStillTarget; void oldTargetStillHolds;
    /* Chat card announcing the reversal. */
    if (ChatMessage?.create) {
        try {
            await ChatMessage.create({
                content:
                    '<div class="wdm-attack-rider" style="border-left:3px solid #b98;padding-left:6px;">' +
                        `🔁 <strong>${newHolder?.name ?? "Reverser"}</strong> reverses the ${kind}: ` +
                        `<strong>${newTarget?.name ?? "Former holder"}</strong> is now on the losing side.` +
                    '</div>'
            });
        } catch (_) { /* best-effort */ }
    }
    return true;
}
export { _doReverseHold };

/** Clear hold(s) on an actor. Modes:
 *
 *    clearHoldLink(actor, reason)                — cascade: clears
 *                                                   every pair the
 *                                                   actor is in.
 *    clearHoldLink(actor, reason, partnerActor)  — targeted: clears
 *                                                   only the pair
 *                                                   between actor and
 *                                                   partnerActor.
 *
 *  Non-GM callers route through the socket. */
export async function clearHoldLink(actor, reason = "manual", partnerActor = null) {
    if (!actor) return false;
    if (game.user?.isActiveGM) return _doClearHoldLink(actor, reason, partnerActor);
    try {
        game.socket?.emit(`system.${SYSTEM_ID}`, {
            type: "holdClear",
            actorUuid: actor.uuid,
            partnerUuid: partnerActor?.uuid ?? null,
            reason,
            senderUserId: game.user?.id
        });
        return true;
    } catch (err) {
        console.warn(`${SYSTEM_ID} | holdClear socket emit failed`, err);
        return false;
    }
}

/** Hook handler — any token movement while the actor is in a hold
 *  breaks EVERY pair they're in. Rationale: clinch consumes your
 *  movement action; the moment you spend movement (any distance,
 *  any direction), you step out of every hold you were in. Both
 *  parties can trigger this — the hook is symmetric.
 *
 *  Not distance-based: a distance-threshold check falsely kept the
 *  pair alive when a clinched actor "moved one tile" in a direction
 *  that still left them Chebyshev-adjacent (e.g. diagonally around
 *  the clincher). The user's rule is "movement action breaks clinch",
 *  not "distance breaks clinch".
 *
 *  Gating notes:
 *    - Runs on EVERY client; guard with isActiveGM so the clear only
 *      fires once regardless of client count.
 *    - Resolve the world actor before the registry lookup — a
 *      synthetic (unlinked) tokenDoc.actor won't match the world uuid
 *      the pair was stored under. */
async function onUpdateTokenForHold(tokenDoc, changes, _options, _userId) {
    if (!game.user?.isActiveGM) return;
    /* CE Ride follow-mount (2026-07-03).
     *
     * When the MOUNT'S token moves, the RIDER'S token slaves to the
     * same position — per the user's CE spec: "if you are riding an
     * enemy, you can't move and you move wherever the enemy does".
     * The rider's `restrict.move` (from the `isMounted` clause)
     * already refuses their own drag; this hook handles the "follow"
     * half by mirroring the mount's move.
     *
     * Pair convention: rider is HOLDER, mount is TARGET of a `mounted`
     * pair. When a token whose actor is TARGET moves, find the
     * corresponding HOLDER and copy the new position onto their
     * token. Symmetric enough that we don't risk moving the mount
     * back — we only READ position from the moving token and WRITE
     * position onto the rider's. */
    if (changes?.x == null && changes?.y == null) return;
    if (!tokenDoc?.actor?.uuid) return;
    const actor = tokenDoc.actor;
    const worldUuid = normalizedActorUuid(actor);
    if (!worldUuid) return;
    const { getHolds } = await import("./holdRegistry.mjs");
    const pairs = await getHolds(worldUuid);
    /* Only fire when THIS token's actor is the TARGET of a mounted
     * pair (i.e., the moving actor is the mount). Riders can't move
     * on their own; the rider's `isMounted` restrict.move is what
     * would refuse their independent drag. */
    const mountedPairs = pairs.filter(p =>
        p.kind === "mounted" && p.targetUuid === worldUuid);
    if (mountedPairs.length === 0) return;
    for (const p of mountedPairs) {
        try {
            const rider = await fromUuid(p.holderUuid);
            if (!rider) continue;
            const riderTokens = rider.getActiveTokens?.() ?? [];
            for (const rt of riderTokens) {
                if (!rt.document) continue;
                await rt.document.update({
                    x: Number(changes.x ?? tokenDoc.x),
                    y: Number(changes.y ?? tokenDoc.y)
                }, { animate: true });
            }
        } catch (err) {
            console.warn(`${SYSTEM_ID} | follow-mount move failed`, err);
        }
    }
}

/** Hook handler — when an actor gains an incapacitation status,
 *  every pair they're in breaks (cascade). Rationale: a stunned /
 *  prone / dead actor can no longer maintain any hold. */
async function onUpdateActorForHold(actor, _changes, _options, _userId) {
    if (!game.user?.isActiveGM) return;
    if (!actor) return;
    const pairs = await getHoldLinks(actor);
    if (pairs.length === 0) return;
    for (const sid of HOLD_BREAK_STATUSES) {
        if (actor.statuses?.has?.(sid)) {
            /* Cascade: clear every pair the incapacitated actor is in. */
            await clearHoldLink(actor, `incapacitation: ${sid}`);
            return;
        }
    }
}

/** Register the hold-related hooks once at world init. */
export function registerHoldLinkHooks() {
    /* updateToken hook — RAW-aligned grapple/pin/choke doesn't auto-
     * break on movement (Escape action is the only way out). CE Ride
     * DOES need this hook wired: the rider's token slaves to the
     * mount's position whenever the mount moves. `onUpdateTokenForHold`
     * short-circuits for any pair kind other than `mounted`, so RAW
     * holds pay only a cheap early-return per token move. */
    Hooks.on?.("updateToken", onUpdateTokenForHold);
    Hooks.on?.("updateActor", onUpdateActorForHold);
    /* Sweep registry on actor delete so a deleted token/PC doesn't
     * leave orphan pairs. */
    Hooks.on?.("deleteActor", async (actor, _opts, _userId) => {
        if (!game.user?.isActiveGM) return;
        if (!actor?.uuid) return;
        try {
            const { sweepDeletedActor } = await import("./holdRegistry.mjs");
            await sweepDeletedActor(actor.uuid);
        } catch (err) {
            console.warn(`witcher-ttrpg-death-march | hold sweep on delete failed`, err);
        }
    });
    /* Hide the registry actor from the GM's Actor Directory. */
    Hooks.on?.("renderActorDirectory", (_app, html) => {
        try {
            const root = html instanceof HTMLElement ? html : html?.[0];
            if (!root) return;
            const rows = root.querySelectorAll?.('li.directory-item[data-entry-id]') ?? [];
            for (const row of rows) {
                const id = row.dataset?.entryId;
                const a = id ? game.actors?.get(id) : null;
                if (a?.getFlag?.("witcher-ttrpg-death-march", "isHoldRegistry")) {
                    row.remove();
                }
            }
        } catch (_) { /* best-effort */ }
    });
    /* Status-create / -delete also matter — Foundry's status changes
     * route through ActiveEffect, not actor data, so a pure
     * updateActor hook misses them. Watch the AE side too. */
    Hooks.on?.("createActiveEffect", async (effect, _opts, _userId) => {
        if (!game.user?.isActiveGM) return;
        const actor = effect?.parent;
        if (!actor?.uuid) return;
        const sids = (effect.statuses && effect.statuses.size ? [...effect.statuses] : [])
            .concat(effect?.flags?.core?.statusId ? [effect.flags.core.statusId] : []);
        if (sids.some(s => HOLD_BREAK_STATUSES.includes(s))) {
            const pairs = await getHoldLinks(actor);
            if (pairs.length > 0) {
                await clearHoldLink(actor, `incapacitation: ${sids.find(s => HOLD_BREAK_STATUSES.includes(s))}`);
            }
        }
    });
}
