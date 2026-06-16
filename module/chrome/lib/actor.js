/**
 * Read the user's assigned character and derive the values the dock
 * displays. Wrapped in try/catch so a missing field doesn't crash render.
 *
 * Data paths follow the Witcher TRPG system (TheWitcherTRPG). Adjust here
 * if/when paths change between system versions.
 */

/* Shared session-only "view as" override.  When a GM picks a character from
 * any tab's "View as" dropdown (inventory / character / journal / bestiary),
 * `getAssignedActor()` reports that character to every UI surface that asks
 * — dock, hotbar, every overlay panel.  Non-GMs cannot impersonate; the
 * override is gated on `game.user.isGM` at read time.  Cleared on reload.
 *
 * Setting the override fires `VIEWER_OVERRIDE_HOOK` so chrome that doesn't
 * have a natural re-render trigger (the dock, hotbar, currently-open tab)
 * can pick up the change.
 */
import { isAdrenalineEnabled } from "../../api/adrenaline.mjs";

export const VIEWER_OVERRIDE_HOOK = "witcher-ttrpg-death-march:viewerOverrideChanged";
let _actorOverrideId = null;

export function setActorOverride(actorId) {
  const next = actorId ? String(actorId) : null;
  if (next === _actorOverrideId) return;
  _actorOverrideId = next;
  Hooks.callAll(VIEWER_OVERRIDE_HOOK, next);
}

export function getActorOverride() {
  return _actorOverrideId;
}

export function getAssignedActor() {
  const u = game?.user;
  if (u?.isGM && _actorOverrideId) {
    const override = game.actors?.get?.(_actorOverrideId);
    if (override?.type === "character") return override;
  }
  // A single controlled, owned token drives the dock — so the action-economy
  // and combat flow run on the TOKEN's actor (the same document the combat
  // tracks, incl. unlinked/synthetic actors), not the base character. Falls
  // back to the user's assigned character when no single token is controlled.
  const controlled = canvas?.tokens?.controlled ?? [];
  if (controlled.length === 1) {
    const tokenActor = controlled[0]?.actor;
    if (tokenActor?.isOwner) return tokenActor;
  }
  return u?.character ?? null;
}

/* True when there's a started Foundry combat and `actor` is one of its
 * combatants. Action-economy auto-spend (attack / cast / draw) gates on this
 * so the slots are only consumed during an actual encounter — out of combat
 * the buttons stay free and drawing a weapon doesn't burn an action. */
export function isActorInActiveCombat(actor) {
  const c = game?.combat;
  if (!c?.started || !actor) return false;
  // Match by token first (a synthetic/unlinked token actor carries its token),
  // so the right combatant is found even when several tokens share a base actor.
  const tokenId = actor.token?.id ?? null;
  return c.combatants?.some(cb =>
    (tokenId && cb.tokenId === tokenId) || (cb.actorId ?? cb.actor?.id) === actor.id
  ) ?? false;
}

const NULL_POOL = { cur: 0, max: 0, frac: 0 };

function safe(getter, fallback) {
  try { const v = getter(); return (v === undefined || v === null) ? fallback : v; }
  catch { return fallback; }
}

function pool(cur, max) {
  cur = Number(cur) || 0;
  max = Number(max) || 0;
  return { cur, max, frac: max > 0 ? Math.max(0, Math.min(1, cur / max)) : 0 };
}

/* HP pool with a temp-HP "shield" buffer folded in. Temp blends into the
 * displayed numbers (cur = value+temp, max = realMax+temp) so the readout and
 * sawtooth read as one bar, but the segments stay separate: amber `realFrac`
 * for real HP, frost `tempFrac` for the shield sitting contiguous after it.
 * `realCur`/`realMax` are kept raw for severity (wounds key off real HP, not
 * the shield). Denominator is (realMax + temp). */
function hpPool(value, max, temp) {
  value = Math.max(0, Number(value) || 0);
  max   = Math.max(0, Number(max)   || 0);
  temp  = Math.max(0, Number(temp)  || 0);
  const den   = (max + temp) || 1;
  const clamp = (n) => Math.max(0, Math.min(1, n));
  return {
    cur:      value + temp,
    max:      max + temp,
    temp,
    hasTemp:  temp > 0,
    realCur:  value,
    realMax:  max,
    frac:     clamp((value + temp) / den),
    realFrac: clamp(Math.min(value, max) / den),
    tempFrac: clamp(temp / den)
  };
}

export function getDockData(actor) {
  if (!actor) {
    return {
      name: "— no character assigned —",
      profession: "",
      race: "",
      medallion: "",
      hp:  { ...NULL_POOL },
      sta: { ...NULL_POOL },
      tox: { ...NULL_POOL },
      adrenaline: { cur: 0, max: 3 },
      stress:     { cur: 0, max: 0 },
      satiety:    null,
      shield:     { cur: 0, max: 0 },
      vigor:      0,
      combatRound: null
    };
  }

  const s = actor.system ?? {};

  // Identity — Profession and Race are EMBEDDED ITEMS on the actor
  // (system.items of type "profession" / "race"), not raw string fields.
  const name       = actor.name ?? "—";
  const profItem   = safe(() => actor.items?.find(i => i.type === "profession"), null);
  const raceItem   = safe(() => actor.items?.find(i => i.type === "race"), null);
  const profession = safe(() => String(profItem?.name ?? ""), "");
  const race       = safe(() => String(raceItem?.name ?? ""), "");
  // Medallion icon is linked to the PROFESSION item (system.medallionIcon).
  // No profession, or none set → empty, and the dock hides the medallion.
  const medallion  = safe(() => String(profItem?.system?.medallionIcon ?? ""), "");

  // Pools — Witcher TRPG schema:
  //   derivedStats.{hp,sta}.{value,max}    primary pools
  //   stats.toxicity.{value,max}           alchemical buildup (default max 100)
  const hpCur  = safe(() => s.derivedStats?.hp?.value, 0);
  const hpMax  = safe(() => s.derivedStats?.hp?.max, 0);
  const hpTemp = safe(() => s.derivedStats?.hp?.temp, 0);
  const staCur = safe(() => s.derivedStats?.sta?.value, 0);
  const staMax = safe(() => s.derivedStats?.sta?.max, 0);
  const toxCur = safe(() => s.stats?.toxicity?.value, 0);
  const toxMax = safe(() => s.stats?.toxicity?.max, 0);

  // Counters
  //   adrenaline           system.adrenaline.value           (max = body stat)
  //   stress (homebrew)    system.stress; max = will. Only present when the
  //                        "stress" homebrew toggle is enabled — otherwise the
  //                        dock/topbar must not show the tracker at all.
  //   shield (Quen)        system.derivedStats.shield            (single number, no max — schema Phase 13)
  const adrOn  = safe(() => isAdrenalineEnabled(), true);
  const adrCur = safe(() => s.adrenaline?.value, 0);
  const adrMax = safe(() => Number(s.stats?.body?.value) || 0, 0);
  const stressOn = safe(() => game.system?.api?.homebrew?.isEnabled?.("stress"), false);
  const strCur = safe(() => Number(s.stress) || 0, 0);
  const strMax = safe(() => s.stats?.will?.value, 0);
  // Satiety (homebrew food & drink). Range conceptually -100 … 125; the field
  // is editable BY THE GM ONLY (preUpdateActor hook in foodAndDrink.mjs drops
  // player writes). The character sheet uses both `cur` and `tier` to render
  // — tier is the engine-derived hunger ladder label.
  const fdOn   = safe(() => game.system?.api?.homebrew?.isEnabled?.("foodAndDrink"), false);
  const satCur = safe(() => Number(s.satiety) || 0, 0);
  const satTier = safe(() => game.system?.api?.mechanics?.foodAndDrink?.tierForSatiety?.(satCur) ?? "", "");
  const shdCur = safe(() => Number(s.derivedStats?.shield) || 0, 0);
  const shdMax = shdCur; // single-number stat; renderer uses (cur, max) shape so mirror it

  // Investigation Focus pool (A Witcher's Journal p.145): real pool with a
  // derived max ⌊(WILL+INT)/2⌋×3; value player-set, drained by Evidence checks.
  const focCur = safe(() => Number(s.derivedStats?.focus?.value) || 0, 0);
  const focMax = safe(() => Number(s.derivedStats?.focus?.max) || 0, 0);

  // Vigor — single static threshold (Core p.38). Must live in the dock data so
  // it joins the rebind signature; otherwise a vigor-only edit produces an
  // unchanged sig and the dock skips the rebind (stale until F5). Legacy
  // {value,max} world data falls through until the first save rewrites it.
  const vigRaw = safe(() => s.derivedStats?.vigor, 0);
  const vigor  = (typeof vigRaw === "number" ? vigRaw : (vigRaw?.max ?? vigRaw?.value ?? 0)) || 0;

  // Round Chaos — magic STA poured into spells so far this combat round
  // (castSpellMixin's `chaosRound` flag). Drives the segmented vigor bar's
  // depletion. Zero out of combat or when the flag is from an older round, so
  // the bar reads full. Part of the return object → joins the rebind signature.
  const vigorSpent = safe(() => {
    const combat = game.combat;
    const roundNo = combat?.started ? combat.round : null;
    if (roundNo == null) return 0;
    const f = actor.getFlag?.("witcher-ttrpg-death-march", "chaosRound") ?? {};
    return f.round === roundNo ? (Number(f.spent) || 0) : 0;
  }, 0);

  // Combat round budget (Core p.151-152). Folded into the dock data so a
  // movement/action/extra/defense change joins the rebind signature and the
  // slot pills repaint live. SPD rides along for the movement prompt default.
  const cr  = s.combatRound ?? {};
  const spd = safe(() => Number(s.stats?.spd?.value) || 0, 0);
  const combatRound = {
    movementUsed:    !!cr.movementUsed,
    movementMeters:  Number(cr.movementMeters) || 0,
    actionUsed:      !!cr.actionUsed,
    actionLabel:     String(cr.actionLabel ?? ""),
    extraUsed:       !!cr.extraUsed,
    extraLabel:      String(cr.extraLabel ?? ""),
    fullRound:       !!cr.fullRound,
    fullRoundLabel:  String(cr.fullRoundLabel ?? ""),
    defenseCount:    Number(cr.defenseCount) || 0,
    activelyDodging: !!cr.activelyDodging,
    spd
  };

  return {
    name, profession, race, medallion,
    hp:  hpPool(hpCur, hpMax, hpTemp),
    sta: pool(staCur, staMax),
    tox: pool(toxCur, toxMax),
    adrenaline: adrOn ? { cur: Number(adrCur) || 0, max: adrMax } : null,
    stress:     stressOn ? { cur: Number(strCur) || 0, max: Number(strMax) || 0 } : null,
    satiety:    fdOn ? { cur: satCur, tier: satTier, max: 125 } : null,
    shield:     { cur: Number(shdCur) || 0, max: Number(shdMax) || 0 },
    focus:      { cur: Number(focCur) || 0, max: Number(focMax) || 0 },
    vigor,
    vigorSpent,
    combatRound
  };
}
