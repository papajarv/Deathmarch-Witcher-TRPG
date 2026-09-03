import { t, tFormat } from "../chrome/lib/i18n.js";
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
export const HOLD_STATUSES = Object.freeze(["grappled", "pinned", "clinched", "chokeheld"]);

/** Combat-Extended-only visible holder-side counterparts.
 *  Stamped on the HOLDER of a hold pair when CE is on so the token
 *  HUD shows who is currently holding whom. Zero mods live in the
 *  clauses — the -2 / -3 penalty comes from the runtime carve-out
 *  in mechanics/holdModifiers.contextualPhysicalMod (which knows to
 *  skip the penalty when the roll target is the actor's partner). */
const HOLDER_STATUS_BY_KIND = Object.freeze({
    grappled:  "isGrappling",
    pinned:    "isPinning",
    chokeheld: "isChoking",
    clinched:  "isClinching" // CE clinch aggressor — visible-only, both sides marked
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
 *  every hold they're in — and to bar them from initiating one.
 *  stunned (can't actively maintain), unconscious / dead (obvious).
 *
 *  House rule: PRONE is deliberately NOT here. Going prone neither
 *  breaks an existing grapple/pin nor stops you from grappling — you
 *  can wrestle on the ground. (A prone actor who crawls out of reach
 *  still breaks the hold via the distance check — that's movement,
 *  not the prone status.) */
/* Statuses that a HOLDER can't be under to INITIATE a hold (apply-refusal). */
const HOLD_BREAK_STATUSES = Object.freeze(["stunned", "unconscious", "dead"]);
/* Statuses that break an EXISTING hold (the incapacitation cascade). Being
 * merely STUNNED no longer drops holds — a stunned foe stays grappled/choked
 * (otherwise one Stun frees every grapple in play, which is silly). Only the
 * terminal states end holds. */
const HOLD_CASCADE_STATUSES = Object.freeze(["unconscious", "dead"]);

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
            content: `<p>${t("WITCHER.Mech.HoldLink.Text.NoTokensOnCanvasForThisClinchIs", "No tokens on canvas for this clinch. Is")} <strong>${holderName}</strong> adjacent to <strong>${targetName}</strong>?</p>`
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
async function _doApplyHoldLink(holder, target, kind, opts = {}) {
    if (!holder || !target || holder === target) return false;
    if (!HOLD_STATUSES.includes(kind)) return false;
    /* Refuse to apply if the holder is incapacitated — a stunned /
     * unconscious / dead actor can't initiate a hold. (Prone can — see
     * HOLD_BREAK_STATUSES; you can grapple from the ground.) */
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
    /* NOTE: choke damage is now ACTION-DRIVEN (the choker re-Chokes each turn,
     * spending an action to deal 3 + melee bonus + Strangling through armor —
     * see brawlMixin / weaponAttackMixin choke handlers). We deliberately do
     * NOT co-apply the passive `suffocation` DoT here anymore — that would
     * double-dip on top of the per-action damage. The `chokeheld` status (and
     * holder-side `isChoking`) still stamp for the visual + Close Quarters. */
    /* Holder-side status stamp.
     *
     *   grappled → isGrappling stamps in BOTH RAW and CE. Core p.161 says
     *   the grappler cannot move away from the grappled target without
     *   releasing the hold — that lock lives on isGrappling's restrict.move
     *   clause. The −2 damage-side carve-out is CE-only and enforced by
     *   contextualPhysicalMod itself (which returns 0 under RAW), so we
     *   don't need a CE gate here to keep the RAW roll math clean.
     *
     *   pinned/chokeheld → CE-only visual/movement flourishes
     *   (isPinning carries the pinner's move-lock; isChoking is visible-
     *   only). RAW leaves these holder-side slots empty. */
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
    /* Pinning breaks the PINNEE's OWN grapples. A pinned target is fully
     * restrained — they can't keep holding anyone else, so every hold where
     * the freshly-pinned target is the HOLDER drops (their grapplee(s) go
     * free). Only for pin; a plain grapplee CAN still grapple others. */
    if (kind === "pinned" && wasNew) {
        try {
            const { getHolds } = await import("./holdRegistry.mjs");
            const tgtPairs = await getHolds(targetUuid);
            for (const p of tgtPairs) {
                if (p.holderUuid !== targetUuid) continue;   // only holds THEY maintain
                const heldActor = await fromUuid(p.targetUuid).catch(() => null);
                await _doClearHoldLink(target, "pinned-loses-grip", heldActor);
            }
        } catch (err) {
            console.warn(`${SYSTEM_ID} | pin: clearing pinnee's own grapples failed`, err);
        }
    }
    /* Announce every new hold in chat with a clear "holder → target"
     * card so the whole table can see who is the DOMINANT one and who
     * is HELD. Duplicates (setHold returning false) don't re-announce.
     * Also lists follow-up actions available to the holder — Pin,
     * Choke, Throw — so the player doesn't have to hunt for them.
     * Best-effort: a failed ChatMessage.create doesn't abort the
     * pair storage. */
    if (wasNew && !opts.silent && ChatMessage?.create) {
        const emoji = kind === "chokeheld" ? "🫁"
                    : kind === "pinned"    ? "🪤"
                    : kind === "clinched"  ? "🤝"
                    : "🤼";
        const kindLabel = kind === "chokeheld" ? t("WITCHER.Mech.HoldLink.Text.Chokeholds", "Choke-holds")
                        : kind === "pinned"    ? t("WITCHER.Mech.HoldLink.Text.PinsPlural", "pins")
                        : kind === "clinched"  ? t("WITCHER.Mech.HoldLink.Text.ClinchesPlural", "clinches")
                        : t("WITCHER.Mech.HoldLink.Text.GrapplesPlural", "grapples");
        const followUps = kind === "grappled"
            ? `<div class="wdm-attack-note" style="margin-top:6px;"><i class="fa-solid fa-arrow-right"></i> ${tFormat("WITCHER.Mech.HoldLink.Text.GrappledFollowup", { holder: holder?.name ?? t("WITCHER.Mech.HoldLink.Text.Holder", "Holder"), target: target?.name ?? t("WITCHER.Mech.HoldLink.Text.Target", "Target"), pin: t("WITCHER.Mech.HoldLink.Text.Pin", "Pin"), choke: t("WITCHER.Mech.HoldLink.Text.Choke", "Choke"), thrw: t("WITCHER.Mech.HoldLink.Text.Throw", "Throw"), escape: t("WITCHER.Mech.HoldLink.Text.Escape", "Escape") }, `<strong>${holder?.name ?? "Holder"}</strong> can now attempt <em>Pin</em>, <em>Choke</em>, or <em>Throw</em> against <strong>${target?.name ?? "Target"}</strong>. Target can spend an Action for <em>Escape</em> (Dodge/Escape vs Brawling).`)}</div>`
            : kind === "pinned" || kind === "chokeheld"
                ? `<div class="wdm-attack-note" style="margin-top:6px;"><i class="fa-solid fa-arrow-right"></i> ${t("WITCHER.Mech.HoldLink.Text.TargetCanSpendAnActionFor", "Target can spend an Action for")} <em>${t("WITCHER.Mech.HoldLink.Text.Escape", "Escape")}</em> (Dodge/Escape vs Brawling).</div>`
                : "";
        try {
            await ChatMessage.create({
                content:
                    '<div class="wdm-attack-rider" style="border-left:3px solid #b98;padding-left:6px;">' +
                        `${emoji} <strong>${(holder?.name ?? t("WITCHER.Mech.HoldLink.Text.Holder", "Holder"))}</strong> ${kindLabel} <strong>${(target?.name ?? t("WITCHER.Mech.HoldLink.Text.Target", "Target"))}</strong>.` +
                    '</div>' + followUps
            });
        } catch (_) { /* best-effort */ }
    }
    /* CLINCH positioning + cost. The clincher steps right up to the target's
     * face (token centre on the shared grid line, ½ tile out) and the act of
     * closing in spends their whole movement for the turn. Only for the
     * `clinched` variant and only for genuinely new pairs (a duplicate
     * re-apply shouldn't re-teleport or re-charge). Positioning is a dynamic
     * import to avoid a static clinch.mjs ↔ holdLink.mjs cycle. */
    if (kind === "clinched" && wasNew) {
        try {
            const { positionClincher } = await import("./clinch.mjs");
            await positionClincher(holder, target);
        } catch (err) { console.warn(`${SYSTEM_ID} | clinch positioning hook failed`, err); }
        if (holder?._inActiveCombat) {
            try { await holder.update({ "system.combatRound.movementUsed": true }); }
            catch (_) { /* best-effort — clinch still stands */ }
        }
    }
    /* Pin positioning: the pinner steps onto the pinned foe (½ tile) and sits
     * ABOVE them; the pinner's original tile is stashed for a clean restore on
     * break/reverse. Only on a genuinely new pin. */
    if (kind === "pinned" && wasNew) {
        try {
            const { positionPinner } = await import("./clinch.mjs");
            await positionPinner(holder, target);
        } catch (err) { console.warn(`${SYSTEM_ID} | pin positioning hook failed`, err); }
    }
    /* Grapple IMPLIES a clinch. A grappled foe is chest-to-chest with the
     * grappler, so establish a `clinched` pair too — that lights up Close
     * Quarters weapons and marks BOTH sides in a clinch. It is a SEPARATE
     * pair: breaking the grapple (Escape peels the top layer = grappled)
     * leaves this clinch intact; the victim must Escape a second time to
     * shed the clinch. `noReposition` because the grapple already put them
     * together — no teleport / movement-spend — and `silent` because the
     * grapple card already announced the hold. CE-only — clinch is not a
     * RAW concept, so under RAW a grapple stays a plain grapple. The clinch
     * repositions the grappler into the target's face (positionClincher),
     * same as a manual clinch — grappling is chest-to-chest. */
    /* A grapple formed AT RANGE (a reach Grappling weapon — grapplee not
     * adjacent) is NOT chest-to-chest, so it does not auto-establish a clinch
     * and does not yank the foe adjacent. They stay at the weapon's reach,
     * grappled; the grappler must Drag them in before the close follow-ups
     * (pin / choke / throw …). `areActorsAdjacent === false` means genuinely at
     * range; `true`/`null` (adjacent or tokenless) keep the RAW-CE clinch. */
    if (kind === "grappled" && wasNew && isCEOn() && areActorsAdjacent(holder, target) !== false) {
        try {
            await _doApplyHoldLink(holder, target, "clinched", { silent: true });
        } catch (err) { console.warn(`${SYSTEM_ID} | grapple auto-clinch failed`, err); }
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
export async function applyHoldLink(holder, target, kind, { allowReach = false } = {}) {
    if (!holder || !target || holder === target) return false;
    if (!HOLD_STATUSES.includes(kind)) return false;
    /* Adjacency gate — runs on the initiator's client so the prompt
     * (if any) shows to the correct user. brawlMixin also runs this
     * check UPSTREAM (before the roll + resource spend) so the failure
     * lands as an actionable prompt, not a wasted turn. This inner
     * check stays as a safety net for any caller that skips the
     * upstream gate.
     *
     * `allowReach` (CE) lets a caller that has ALREADY validated reach —
     * e.g. a Grappling weapon with Long/Extreme reach establishing a grapple
     * at arm's length — bypass the adjacency refusal so the hold can form at
     * range. Defaults false, so every existing caller is unchanged. */
    const adj = allowReach ? true : areActorsAdjacent(holder, target);
    if (adj === false) {
        try {
            const hName = holder?.name ?? t("WITCHER.Mech.HoldLink.Text.Holder", "Holder");
            const tName = target?.name ?? t("WITCHER.Mech.HoldLink.Text.TargetLower", "target");
            const msg = game.i18n?.format?.("WITCHER.Clinch.NotAdjacent",
                { holder: hName, target: tName })
                || `${hName} isn't within reach of ${tName} — step adjacent (within 1 tile) before brawling.`;
            ui?.notifications?.warn?.(msg);
        } catch (_) { /* ignore */ }
        return false;
    }
    if (adj === null) {
        const ok = await promptAdjacency(holder?.name ?? t("WITCHER.Mech.HoldLink.Text.Holder", "Holder"), target?.name ?? t("WITCHER.Mech.HoldLink.Text.Target", "Target"));
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
async function _doClearHoldLink(actor, reason, partnerActor = null, kind = null) {
    if (!actor) return false;
    const actorUuid = normalizedActorUuid(actor);
    if (!actorUuid) return false;
    const { clearHold, getHolds } = await import("./holdRegistry.mjs");
    const removed = await clearHold(actorUuid, normalizedActorUuid(partnerActor), kind);
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
         *   - `pinned/chokeheld` holder-side flourishes are CE-only, so
         *     they only need stripping when CE is on.
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
    /* Recentre clinch HOLDERS whose pair just ended. While clinched, the
     * holder's token sits on the shared grid line (½ tile in, from
     * positionClincher). The moment the clinch breaks — for ANY reason,
     * triggered by EITHER party — the holder returns to the centre of its
     * own tile. GM-side; issued with wdmClinchMove/wdmForcedMove so it
     * neither re-breaks a clinch nor charges movement budget. When the
     * holder themselves moved (break-step already snapped them to a cell
     * centre) this is a no-op. Skipped gridless (no tile centre). */
    try {
        const grid = canvas?.grid;
        const gs = Number(canvas?.scene?.grid?.size) || 0;
        const gridReady = gs > 0 && grid?.getOffset && grid?.getCenterPoint;
        for (const pair of removed) {
            if (pair.kind !== "clinched") continue;
            /* If the HOLDER broke the clinch by their OWN movement, they've
             * already moved to their chosen tile — don't yank them back to
             * a recentre. Only recentre a holder who DIDN'T move (the
             * clinchee moved, or someone hit the break button). But DO strip
             * the origin snapshot: leaving it on the token would be dead data
             * that a future reader could mistake for a live origin. (Correctness
             * no longer depends on this — positionClincher re-stamps fresh — but
             * clean is clean.) */
            if (reason === "movement" && pair.holderUuid === actorUuid) {
                try {
                    const hActor = await fromUuid(pair.holderUuid);
                    const hDoc = hActor?.getActiveTokens?.()?.[0]?.document;
                    if (hDoc && (hDoc.getFlag?.(SYSTEM_ID, "clinchPrevPos") != null
                              || hDoc.getFlag?.(SYSTEM_ID, "clinchPrevSort") != null)) {
                        await hDoc.update({
                            [`flags.${SYSTEM_ID}.-=clinchPrevPos`]:  null,
                            [`flags.${SYSTEM_ID}.-=clinchPrevSort`]: null
                        }, { wdmClinchMove: true, wdmForcedMove: true });
                    }
                } catch (err) { console.warn(`${SYSTEM_ID} | clinch snapshot cleanup (holder moved) failed`, err); }
                continue;
            }
            const holderActor = await fromUuid(pair.holderUuid);
            const hTok = holderActor?.getActiveTokens?.()?.[0];
            if (!hTok?.document) continue;

            /* PREFERRED — restore the EXACT origin (top-left + sort) stashed by
             * positionClincher, mirroring pins' restorePinner. Deterministic:
             * independent of the clinchee's current position and grid rounding,
             * so it can never round back onto the ½-tile grid-line cell and
             * leave the clincher stuck forward. Works gridless too. */
            const snap = hTok.document.getFlag?.(SYSTEM_ID, "clinchPrevPos");
            if (snap && Number.isFinite(Number(snap.x)) && Number.isFinite(Number(snap.y))) {
                const clearMarkers = {
                    [`flags.${SYSTEM_ID}.-=clinchPrevPos`]:  null,
                    [`flags.${SYSTEM_ID}.-=clinchPrevSort`]: null   // strip any legacy marker too
                };
                const targetX = Number(snap.x) || 0;
                const targetY = Number(snap.y) || 0;
                const targetSort = Number(snap.sort) || 0;
                const moved = targetX !== hTok.document.x
                    || targetY !== hTok.document.y
                    || targetSort !== (Number(hTok.document.sort) || 0);
                try {
                    await hTok.document.update(
                        moved ? { x: targetX, y: targetY, sort: targetSort, ...clearMarkers } : clearMarkers,
                        { wdmClinchMove: true, wdmForcedMove: true, animate: true }
                    );
                } catch (err) {
                    console.warn(`${SYSTEM_ID} | clinch recentre (snapshot restore) failed`, err);
                }
                continue;
            }

            /* FALLBACK — legacy clinches established before the snapshot existed
             * (only `clinchPrevSort` was stashed). Reverse-engineer the origin
             * cell geometrically. Needs a grid; skipped gridless. */
            if (!gridReady) continue;
            const w = Number(hTok.document.width) || 1;
            const h = Number(hTok.document.height) || 1;
            let center = { x: hTok.document.x + w * gs / 2, y: hTok.document.y + h * gs / 2 };
            /* The holder sits ½ tile toward the target (on the shared
             * grid line), so getOffset(center) is ambiguous and can round
             * to the TARGET's cell ("recenters forward"). Nudge the
             * sample point AWAY from the target first so it resolves to
             * the holder's ORIGIN cell. */
            const targetActor = await fromUuid(pair.targetUuid);
            const tTok = targetActor?.getActiveTokens?.()?.[0];
            if (tTok?.document) {
                const tw = Number(tTok.document.width) || 1, th = Number(tTok.document.height) || 1;
                const tc = { x: tTok.document.x + tw * gs / 2, y: tTok.document.y + th * gs / 2 };
                let ax = center.x - tc.x, ay = center.y - tc.y;
                const al = Math.hypot(ax, ay);
                if (al > 1) center = { x: center.x + ax / al * gs * 0.35, y: center.y + ay / al * gs * 0.35 };
            }
            const c = grid.getCenterPoint(grid.getOffset(center));
            const upd = { x: Math.round(c.x - w * gs / 2), y: Math.round(c.y - h * gs / 2) };
            /* Restore the sort we dropped in positionClincher (clincher
             * had been pushed under the clinchee) and clear the marker. */
            const prevSort = hTok.document.getFlag?.(SYSTEM_ID, "clinchPrevSort");
            if (prevSort != null) {
                upd.sort = Number(prevSort) || 0;
                upd[`flags.${SYSTEM_ID}.-=clinchPrevSort`] = null;
            }
            if (upd.x !== hTok.document.x || upd.y !== hTok.document.y || prevSort != null) {
                try { await hTok.document.update(upd, { wdmClinchMove: true, wdmForcedMove: true, animate: true }); }
                catch (err) { console.warn(`${SYSTEM_ID} | clinch recentre (geometric fallback) failed`, err); }
            }
        }
    } catch (err) { console.warn(`${SYSTEM_ID} | clinch recentre pass failed`, err); }
    /* Restore PINNERS whose pin just ended — put the token back on the exact
     * tile + sort it held before it was stepped onto the foe (like clinch, but
     * an exact restore from the stashed pinPrevPos). */
    try {
        const { restorePinner } = await import("./clinch.mjs");
        for (const pair of removed) {
            if (pair.kind !== "pinned") continue;
            const holderActor = await fromUuid(pair.holderUuid);
            if (holderActor) await restorePinner(holderActor);
        }
    } catch (_) { /* best-effort restore */ }
    /* Chat note per removed pair. */
    if (reason !== "manual" && ChatMessage?.create) {
        for (const pair of removed) {
            try {
                const holder  = await fromUuid(pair.holderUuid);
                const target  = await fromUuid(pair.targetUuid);
                const hName = holder?.name ?? t("WITCHER.Mech.HoldLink.Text.Actor", "Actor");
                const tName = target?.name ?? t("WITCHER.Mech.HoldLink.Text.Partner", "partner");
                const msg = {
                    content:
                        `<div class="wdm-attack-rider"><i class="fa-solid fa-link-slash"></i> ` +
                        tFormat("WITCHER.Mech.HoldLink.Text.BreakHold", { holder: hName, target: tName, kind: pair.kind, reason }, `<strong>${hName}</strong> and <strong>${tName}</strong> break their ${pair.kind} (${reason}).`) +
                        `</div>`,
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
    if (!newHolder || !newTarget || newHolder === newTarget) return false;
    /* Reverse = remove the old pair (newTarget held newHolder) then create the
     * swapped pair (newHolder holds newTarget). Done via the battle-tested
     * clear + apply paths rather than an in-place swap + manual status toggle:
     * _doClearHoldLink strips the old grapplee's status across EVERY token
     * representation (world actor + synthetic tokens) — the manual swap only
     * touched the world actor, so the old `grappled` status could linger on a
     * token, leaving the reverser showing as BOTH grappler and grapplee.
     * `manual` reason + `silent` apply suppress the clear/apply chat so only
     * the reversal card below is posted. */
    const beforeMe = normalizedActorUuid(newHolder);
    /* Confirm the pair actually exists (newTarget holds newHolder) before we
     * tear anything down — a stale reverse shouldn't clear an unrelated hold. */
    const { getHolds } = await import("./holdRegistry.mjs");
    const myPairs = await getHolds(beforeMe);
    const partnerUuid = normalizedActorUuid(newTarget);
    /* Every layer the current holder (newTarget) maintains on the reverser
     * (newHolder). Reversing a PIN inherits the whole stack — the reverser
     * becomes both pinner AND grappler — so we swap ALL layers, not just the
     * requested one. The requested `kind` (the top layer being reversed) must
     * be present, else it's a stale reverse. */
    const stackKinds = myPairs
        .filter(p => p.holderUuid === partnerUuid && p.targetUuid === beforeMe)
        .map(p => p.kind);
    if (!stackKinds.includes(kind)) return false;

    await _doClearHoldLink(newHolder, "manual", newTarget);   // strip old grapplee/holder statuses (all layers)
    /* Re-apply every layer SWAPPED, base → top, so statuses layer correctly
     * (grappled before pinned before chokeheld). */
    const REAPPLY_ORDER = ["grappled", "pinned", "chokeheld", "clinched"];
    for (const k of REAPPLY_ORDER) {
        if (stackKinds.includes(k)) {
            await _doApplyHoldLink(newHolder, newTarget, k, { silent: true });
        }
    }
    /* Chat card announcing the reversal. */
    if (ChatMessage?.create) {
        try {
            await ChatMessage.create({
                content:
                    '<div class="wdm-attack-rider" style="border-left:3px solid #b98;padding-left:6px;">' +
                        tFormat("WITCHER.Mech.HoldLink.Chat.Reversal", { newHolder: newHolder?.name ?? t("WITCHER.Mech.HoldLink.Text.Reverser", "Reverser"), kind, newTarget: newTarget?.name ?? t("WITCHER.Mech.HoldLink.Text.FormerHolder", "Former holder") }, `🔁 <strong>${newHolder?.name ?? "Reverser"}</strong> reverses the ${kind}: <strong>${newTarget?.name ?? "Former holder"}</strong> is now on the losing side.`) +
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
export async function clearHoldLink(actor, reason = "manual", partnerActor = null, kind = null) {
    if (!actor) return false;
    if (game.user?.isActiveGM) return _doClearHoldLink(actor, reason, partnerActor, kind);
    try {
        game.socket?.emit(`system.${SYSTEM_ID}`, {
            type: "holdClear",
            actorUuid: actor.uuid,
            partnerUuid: partnerActor?.uuid ?? null,
            kind,
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
    if (changes?.x == null && changes?.y == null) return;
    if (!tokenDoc?.actor?.uuid) return;
    const actor = tokenDoc.actor;
    const worldUuid = normalizedActorUuid(actor);
    if (!worldUuid) return;
    const { getHolds } = await import("./holdRegistry.mjs");
    const pairs = await getHolds(worldUuid);

    /* CLINCH auto-break (GM-side guarantee). Any real token move by someone
     * in a clinch (holder OR target) breaks EVERY clinch they're in. The
     * client-side movement policy (policy/canvas-movement.mjs) already
     * truncates the first move to a break-step and snaps to grid for nice
     * UX; this hook is the backstop that clears the pair even when that
     * client couldn't (cold registry cache, a GM-dragged NPC, a forced
     * move). Idempotent with the client-side clear. Skipped for our own
     * clinch positioning move so establishing a clinch doesn't instantly
     * break it. */
    if (!_options?.wdmClinchMove) {
        const clinchPairs = pairs.filter(p => p?.kind === "clinched"
            && (p.holderUuid === worldUuid || p.targetUuid === worldUuid));
        for (const p of clinchPairs) {
            const partnerUuid = (p.holderUuid === worldUuid) ? p.targetUuid : p.holderUuid;
            try {
                const partner = await fromUuid(partnerUuid);
                await clearHoldLink(actor, "movement", partner ?? null);
            } catch (err) {
                console.warn(`${SYSTEM_ID} | clinch auto-break failed`, err);
            }
        }
    }
}

/** Hook handler — when an actor gains an incapacitation status,
 *  every pair they're in breaks (cascade). Rationale: an unconscious / dead
 *  actor can no longer be part of a hold. STUNNED is deliberately NOT here —
 *  a stun mustn't free every grapple/choke. (Prone is excluded too — grappling
 *  on the ground is fine.) */
async function onUpdateActorForHold(actor, _changes, _options, _userId) {
    if (!game.user?.isActiveGM) return;
    if (!actor) return;
    const pairs = await getHoldLinks(actor);
    if (pairs.length === 0) return;
    for (const sid of HOLD_CASCADE_STATUSES) {
        if (actor.statuses?.has?.(sid)) {
            /* Cascade: clear every pair the incapacitated actor is in. */
            await clearHoldLink(actor, `incapacitation: ${sid}`);
            return;
        }
    }
}

/** Register the hold-related hooks once at world init. */
export function registerHoldLinkHooks() {
    /* updateToken hook — CLINCH auto-break: any move by a clinched actor
     * (holder or target) clears every clinch they're in (GM-side guarantee;
     * the client policy also truncates+snaps the first move). RAW grapple/
     * pin/choke still DON'T auto-break on movement (Escape is their only
     * exit) — those kinds pay only a cheap filter here. */
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
    /* Token deletion breaks any grapple/hold the token's actor was in — a
     * scene-cleanup (or a killed combatant removed from the board) must not
     * leave the PARTNER stuck with a stale grappled/grappling status. Unlike
     * deleteActor (world-actor removal), this fires for the far-more-common
     * "delete the token, keep the actor" case. clearHoldLink (not the bare
     * registry sweep) is used so the surviving partner's status is stripped
     * too. Resolve the world actor via actorId first — it outlives an unlinked
     * token's synthetic actor, so the pair (stored by normalized world uuid)
     * still matches. */
    Hooks.on?.("deleteToken", async (tokenDoc, _opts, _userId) => {
        if (!game.user?.isActiveGM) return;
        try {
            const actor = (tokenDoc?.actorId ? game.actors?.get(tokenDoc.actorId) : null)
                ?? tokenDoc?.actor ?? null;
            if (!actor) return;
            const pairs = await getHoldLinks(actor);
            if (pairs.length > 0) await clearHoldLink(actor, "token deleted");
        } catch (err) {
            console.warn(`witcher-ttrpg-death-march | hold sweep on token delete failed`, err);
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
        if (sids.some(s => HOLD_CASCADE_STATUSES.includes(s))) {
            const pairs = await getHoldLinks(actor);
            if (pairs.length > 0) {
                await clearHoldLink(actor, `incapacitation: ${sids.find(s => HOLD_CASCADE_STATUSES.includes(s))}`);
            }
        }
    });
}
