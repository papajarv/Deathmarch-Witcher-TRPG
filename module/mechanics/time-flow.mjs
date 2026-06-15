/**
 * time-flow — a running in-world clock.
 *
 * Foundry's `game.time.worldTime` only moves when something advances it
 * (combat, or our panel's manual +/- buttons). This makes it FLOW: while the
 * game is unpaused, the primary GM advances worldTime in real time at a
 * configurable rate (`timeFlowRate` game-seconds per real second). Because the
 * advance is a GM-side world mutation it broadcasts `updateWorldTime` to every
 * client, so all of them — clock, weather, scene darkness — stay in lockstep
 * without any extra syncing.
 *
 * Gating: only the single primary GM ticks (so multiple GMs don't double-count),
 * only while `!game.paused`, only when `timeFlowRate > 0`, and only when the
 * inbuilt time/weather widget owns the calendar (`weatherEnabled`). Pausing
 * resets the real-time anchor, so unpausing never jumps by the paused duration.
 */

const SYSTEM_ID = "witcher-ttrpg-death-march";

/* Real-time cadence. Kept SHORTER than one second on purpose: worldTime is
 * integer seconds, so at rate 1 each advance is a single second. If we also
 * sampled once a second, ordinary setInterval jitter (a tick landing at ~980ms)
 * would floor the accumulated carry to 0 and skip that second's advance — the
 * clock visibly stalls, then double-steps to catch up. Oversampling (4×/s) lets
 * the carry cross each whole-second boundary within ~250ms of real time, so the
 * second ticks land steadily. Net elapsed time is unaffected either way (carry
 * preserves the remainder); this is purely about smoothing the display cadence. */
const TICK_MS = 250;

let timer = null;
let lastTs = 0;         // performance.now() of the previous counted tick (0 = anchor)
let carry = 0;          // sub-second game-time remainder (worldTime is integer seconds)
let busy = false;       // a game.time.advance() is in flight

/** Game-seconds advanced per real second. 0 (or unset) = clock frozen. */
function flowRate() {
    try { return Number(game.settings.get(SYSTEM_ID, "timeFlowRate")) || 0; }
    catch (_) { return 0; }
}

function widgetOwnsCalendar() {
    try { return !!game.settings.get(SYSTEM_ID, "weatherEnabled"); }
    catch (_) { return true; }
}

/** Only the primary (most-senior active) GM drives the clock. */
function isPrimaryGm() {
    return !!game.user?.isGM && game.users?.activeGM?.id === game.user?.id;
}

function shouldFlow() {
    // Freeze the real-time clock during a started combat: in a fight, time is
    // locked to the turn order. Foundry advances worldTime by turnTime on every
    // turn/round change (Combat#_onUpdate worldTime deltas), so seconds-based
    // effect durations still count down per turn — letting the wall-clock flow
    // too would drain them continuously even when no one is taking a turn.
    if (game.combat?.started) return false;
    return !game.paused && isPrimaryGm() && widgetOwnsCalendar() && flowRate() > 0;
}

async function tick() {
    if (busy) return;
    if (!shouldFlow()) { lastTs = 0; carry = 0; return; }

    const now = performance.now();
    if (!lastTs) { lastTs = now; return; }   // first counted tick: just anchor

    const realDelta = (now - lastTs) / 1000;
    lastTs = now;

    carry += realDelta * flowRate();
    const whole = Math.floor(carry);
    if (whole < 1) return;
    carry -= whole;

    if (typeof game.time?.advance !== "function") return;
    busy = true;
    try { await game.time.advance(whole); }
    catch (err) { console.warn(`${SYSTEM_ID} | time-flow advance failed`, err); }
    finally { busy = false; }
}

/** Start the running clock. Call once at `ready`. Idempotent. */
export function wireTimeFlow() {
    if (timer) return;
    // Resetting the anchor on pause/unpause means a resume never advances by the
    // time spent paused — the next counted tick re-anchors from "now".
    Hooks.on("pauseGame", () => { lastTs = 0; carry = 0; });
    timer = setInterval(() => { tick(); }, TICK_MS);
}
