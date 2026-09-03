import { t, tFormat } from "../chrome/lib/i18n.js";
/**
 * Cast riders — post-cast chat-card riders for spells / hexes / rituals.
 *
 * A rider is a lightweight subscription: "when a cast card matches THIS
 * predicate, offer THIS button; on click, apply THIS transform to the
 * cast context". Riders inject their own buttons into the card via the
 * `renderChatMessageHTML` hook, gated on the stamped `castContext` flag
 * so only cards from castSpellMixin qualify.
 *
 * Five transform ops cover every WR-magic touchpoint:
 *   - addDamage(formula, source)          bolt +Nd6 (etc.) onto the roll
 *   - rerollDamage(pickHigher)            roll the damage formula twice
 *   - discountSTA(n)                      refund N STA (over-exertion re-billed)
 *   - boostDefense(targetUuid, n)         raise a specific target's defense
 *   - suppressStatus(statusId)            drop a status the cast would apply
 *
 * Riders register with `registerCastRider({ id, predicate, label, ops })`.
 * The predicate receives the parsed castContext + the actor whose owner
 * currently sees the card; it returns truthy when the rider is available.
 * `ops` is an array of the five ops (or a function returning them) that
 * fires when the rider button is clicked.
 *
 * NOTE: this is the shared infrastructure. Individual riders (Combat
 * Meditation, elemental amplifiers, etc.) live alongside their perk
 * implementations and just call `registerCastRider`.
 */

const SYSTEM_ID = "witcher-ttrpg-death-march";

const _riders = new Map();

/**
 * Register a cast rider. Idempotent by id — a second registration with
 * the same id overwrites the first.
 * @param {object}   spec
 * @param {string}   spec.id         unique identifier (namespace by feature)
 * @param {Function} spec.predicate  (castContext, viewerActor) => boolean
 * @param {string}   spec.label      button text
 * @param {string}  [spec.icon]      Font Awesome class (default "fa-wand-magic-sparkles")
 * @param {Function} spec.onClick    async (castContext, viewerActor, msg) => ${t("WITCHER.Mech.CastRiders.Text.Promise", "Promise")}<void>
 */
export function registerCastRider(spec) {
    if (!spec?.id || typeof spec.predicate !== "function" || typeof spec.onClick !== "function") return;
    _riders.set(spec.id, {
        id:        spec.id,
        predicate: spec.predicate,
        label:     spec.label ?? spec.id,
        icon:      spec.icon  ?? "fa-solid fa-wand-magic-sparkles",
        onClick:   spec.onClick
    });
}

/** Remove a rider registration by id. */
export function unregisterCastRider(id) {
    _riders.delete(id);
}

/** Iterate registered riders — used for tests/debug, not the render hook. */
export function listCastRiders() {
    return [..._riders.values()];
}

/* ── Rider ops ─────────────────────────────────────────────────────────
 * Each op mutates the castContext in place and stamps the new value back
 * onto the message. Kept side-effect-free otherwise so a rider can chain
 * multiple ops in one click without racing on the flag write. */

/** Bolt an extra damage formula onto the cast. `source` is a short string
 *  ("Combat Meditation", "Fire Amplifier") that shows up in the audit line.
 *  Existing formula stays; the tail is added with a "+" separator. */
export async function addDamage(msg, castContext, formula, source = "") {
    if (!msg || !castContext || !formula) return castContext;
    const existing = String(castContext.damage?.formula ?? "");
    const combined = existing ? `${existing} + ${formula}` : String(formula);
    castContext.damage = {
        ...(castContext.damage ?? {}),
        formula: combined,
        addedBy: [
            ...(castContext.damage?.addedBy ?? []),
            { formula: String(formula), source: String(source ?? "") }
        ]
    };
    await msg.setFlag(SYSTEM_ID, "castContext", castContext);
    return castContext;
}

/** Mark the cast's damage as reroll-and-pick-higher (or lower). Actual
 *  rolling is deferred until the damage flow fires — this just flags
 *  intent on the envelope. */
export async function rerollDamage(msg, castContext, pickHigher = true) {
    if (!msg || !castContext) return castContext;
    castContext.damage = {
        ...(castContext.damage ?? {}),
        reroll: { active: true, pickHigher: !!pickHigher }
    };
    await msg.setFlag(SYSTEM_ID, "castContext", castContext);
    return castContext;
}

/** Refund N STA to the caster. Re-accounts overExertion: if the refund
 *  dips the effective spend back under (or closer to) the vigor floor,
 *  marginal over is recomputed. Returns the recomputed context. */
export async function discountSTA(msg, castContext, n) {
    if (!msg || !castContext || !(n > 0)) return castContext;
    const caster = castContext.casterUuid ? await fromUuid(castContext.casterUuid) : null;
    if (!caster) return castContext;
    const before = Number(castContext.staSpent) || 0;
    const refund = Math.max(0, Math.min(n, before));
    const after  = before - refund;
    if (refund > 0) {
        const curSta = Number(caster.system?.derivedStats?.sta?.value) || 0;
        await caster.update({ "system.derivedStats.sta.value": curSta + refund });
    }
    /* Re-account overExertion — priorChaos + effective staSpent vs vigor. */
    const threshold  = Number(castContext.overExertion?.threshold)  || 0;
    const priorChaos = Number(castContext.overExertion?.priorChaos) || 0;
    const predicted  = priorChaos + after;
    const marginal   = threshold > 0 ? Math.max(0, predicted - Math.max(threshold, priorChaos)) : 0;
    castContext.staSpent = after;
    castContext.overExertion = { threshold, priorChaos, marginal };
    await msg.setFlag(SYSTEM_ID, "castContext", castContext);
    return castContext;
}

/** Raise a specific target's defense total by N. `targetUuid` matches
 *  one of castContext.targets[i].uuid; a null target updates every
 *  target (area / self spells). */
export async function boostDefense(msg, castContext, targetUuid, n) {
    if (!msg || !castContext) return castContext;
    const delta = Math.round(Number(n) || 0);
    if (!delta) return castContext;
    const targets = Array.isArray(castContext.targets) ? castContext.targets : [];
    for (const t of targets) {
        if (targetUuid && t.uuid !== targetUuid) continue;
        if (Number.isFinite(t.defenseTotal)) t.defenseTotal += delta;
        else t.defenseTotal = delta;
    }
    castContext.targets = targets;
    await msg.setFlag(SYSTEM_ID, "castContext", castContext);
    return castContext;
}

/** Suppress a status the cast was going to apply. Appended to a
 *  `damage.suppressedStatuses` list; the status-apply hook downstream
 *  reads it and skips the matching statusId. */
export async function suppressStatus(msg, castContext, statusId) {
    if (!msg || !castContext || !statusId) return castContext;
    const suppressed = new Set(castContext.damage?.suppressedStatuses ?? []);
    suppressed.add(String(statusId));
    castContext.damage = {
        ...(castContext.damage ?? {}),
        suppressedStatuses: [...suppressed]
    };
    await msg.setFlag(SYSTEM_ID, "castContext", castContext);
    return castContext;
}

/* ── Render hook ───────────────────────────────────────────────────────
 * Fired on every chat-message render. Reads `castContext` from message
 * flags; when present, walks registered riders and injects a button per
 * matching one. Only the current viewer's Manticore/Griffin/etc. sees
 * their own rider — same per-client filtering pattern the attack riders
 * use. */

export function installCastRiderHandler() {
    Hooks.on("renderChatMessageHTML", async (msg, el) => {
        try {
            const castContext = msg?.getFlag?.(SYSTEM_ID, "castContext");
            if (!castContext) return;
            if (!_riders.size) return;
            /* Idempotency — bail if we already rendered the rider rail. */
            if (el.querySelector?.("[data-cast-rider-rail]")) return;
            /* The viewer is the actor whose owner is looking at the card.
             * For a rider gated on "this player's Manticore owns it", the
             * predicate reads it from `game.user.character` or from
             * canvas.tokens.controlled — we don't force a specific reader,
             * we just pass the caster too so predicates can compare. */
            const caster = castContext.casterUuid
                ? await fromUuid(castContext.casterUuid).catch(() => null)
                : null;
            const eligible = [];
            for (const r of _riders.values()) {
                let ok = false;
                try { ok = !!(await r.predicate(castContext, caster)); }
                catch (_) { ok = false; }
                if (ok) eligible.push(r);
            }
            if (!eligible.length) return;
            const rail = document.createElement("div");
            rail.className = "wdm-attack-rider wdm-cast-rider-rail";
            rail.dataset.castRiderRail = "1";
            for (const r of eligible) {
                const btn = document.createElement("button");
                btn.type = "button";
                btn.className = "wdm-attack-damage-roll wdm-cast-rider-btn";
                btn.dataset.riderId = r.id;
                btn.innerHTML = `<i class="${r.icon}"></i> ${r.label}`;
                btn.addEventListener("click", async (ev) => {
                    ev.stopPropagation();
                    if (btn.dataset.consumed === "1") return;
                    btn.dataset.consumed = "1";
                    btn.disabled = true;
                    /* Read fresh castContext at click time — a prior rider
                     * op may have already mutated it. */
                    const fresh = msg.getFlag(SYSTEM_ID, "castContext") ?? castContext;
                    try { await r.onClick(fresh, caster, msg); }
                    catch (err) {
                        console.warn(`witcher-ttrpg-death-march | cast rider ${r.id} failed`, err);
                        btn.disabled = false;
                        btn.dataset.consumed = "0";
                    }
                });
                rail.appendChild(btn);
            }
            /* Append at the end of the card body so riders stack below
             * the effect narrative. */
            (el.querySelector(".message-content") ?? el).appendChild(rail);
        } catch (err) {
            console.warn("witcher-ttrpg-death-march | cast rider render failed", err);
        }
    });
}
