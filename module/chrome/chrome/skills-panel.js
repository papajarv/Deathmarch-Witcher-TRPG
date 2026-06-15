/**
 * Skills popover — a compact tabbed panel that floats above the dock's
 * Skills sign button. 9 stat tabs across the top; each tab shows that
 * stat's header + a list of skills.
 *
 * Interactions:
 *   • Click a stat TAB         → switch the visible panel
 *   • Click a SKILL row        → actor.rollSkill(skillMapKey)
 *   • Click anywhere outside / Esc → close
 *
 * Anchors to whichever Skills sign is currently in the dock (peace or combat
 * tray), so the wedge points at the actual trigger.
 */

import { MODULE_ID } from "../setup/settings.js";

const POPOVER_ID = "wou-skills-pop";
/* Luck and Speed are intentionally not in STATS: no skills hang off them in
 * the Witcher skillMap, so their tabs were empty save-only. STAT_ABBR /
 * STAT_LONG still include "luck" and "spd" because a profession sub-skill can
 * roll off either and we need the abbreviation for the stat-tag pill. */
const STATS = ["int", "ref", "dex", "body", "emp", "cra", "will"];
const STAT_ABBR = { int:"INT", ref:"REF", dex:"DEX", body:"BOD", spd:"SPD", emp:"EMP", cra:"CRA", will:"WIL", luck:"LUC" };
const STAT_LONG = { int:"Intelligence", ref:"Reflex", dex:"Dexterity", body:"Body", spd:"Speed", emp:"Empathy", cra:"Craft", will:"Will", luck:"Luck" };

let _wired = false;
let _activeStat = "ref";

/* ─────────── helpers ─────────── */

function escapeHTML(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function statValue(actor, stat) {
  const s = actor?.system?.stats?.[stat];
  if (!s) return 0;
  return (stat === "luck" ? (s.max ?? s.value ?? 0) : (s.value ?? 0));
}

function statLabel(stat) {
  const i18nKey = `WITCHER.St${stat.charAt(0).toUpperCase() + stat.slice(1)}`;
  return game.i18n?.localize?.(i18nKey) ?? STAT_LONG[stat];
}

/** Group skillMap entries by parent stat, ordered alphabetically by label. */
function buildSkillCatalog() {
  const skillMap = CONFIG?.WITCHER?.skillMap ?? {};
  const labelFor = CONFIG?.WITCHER?.skillLabel;
  const out = Object.fromEntries(STATS.map(s => [s, []]));
  for (const [key, entry] of Object.entries(skillMap)) {
    const stat = entry?.statKey;
    if (!stat || !(stat in out)) continue;
    const i18nKey = labelFor ? labelFor(key) : key;
    out[stat].push({
      key,                                                /* skillMap key — pass to actor.rollSkill */
      name: key,                                          /* data path under system.skills[stat][key] */
      label: game.i18n?.localize?.(i18nKey) ?? key,
    });
  }
  for (const s of STATS) out[s].sort((a, b) => a.label.localeCompare(b.label));
  return out;
}

/* ─────────── profession tab ─────────── */

const PROF_PATH_KEYS = ["skillPath1", "skillPath2", "skillPath3"];
const PROF_SKILL_KEYS = ["skill1", "skill2", "skill3"];

function getProfessionItem(actor) {
  return actor?.items?.find?.(i => i.type === "profession") ?? null;
}

/* A profession sub-skill is rollable iff it has a real stat (not "" / "none"),
 * a non-empty name, and at least 1 point invested. Passive entries and
 * unlearned slots get filtered out. */
function isRollableProfSkill(skill) {
  if (!skill) return false;
  const stat = skill.stat;
  if (!stat || stat === "none") return false;
  const name = String(skill.skillName ?? "").trim();
  if (!name) return false;
  return (Number(skill.level) || 0) > 0;
}

/** Build the data the profession tab needs, or null when there's nothing to show. */
function buildProfessionTab(actor) {
  const prof = getProfessionItem(actor);
  const sys = prof?.system;
  if (!sys) return null;

  const sections = [];
  let totalRollable = 0;

  if (isRollableProfSkill(sys.definingSkill)) {
    sections.push({
      title: "Defining Skill",
      cls: "wou-sp-prof-defining",
      skills: [sys.definingSkill],
    });
    totalRollable++;
  }

  PROF_PATH_KEYS.forEach((key, i) => {
    const path = sys[key];
    if (!path) return;
    const skills = PROF_SKILL_KEYS.map(k => path[k]).filter(isRollableProfSkill);
    if (skills.length === 0) return;
    const pathNum = i + 1;
    sections.push({
      title: String(path.pathName || "").trim() || `Path ${pathNum}`,
      cls: `wou-sp-prof-path wou-sp-prof-path-${pathNum}`,
      skills,
    });
    totalRollable += skills.length;
  });

  if (sections.length === 0) return null;
  return { profession: prof, sections, totalRollable };
}

/* ─────────── inline style fallback ─────────── */

/* Critical layout rules injected inline so the popover renders correctly
 * even if styles/skills-panel.css fails to load (cache, mis-registration,
 * load-order race). External CSS still owns the polish — these are just
 * the structural rules without which the popover is a vertical mess. */
const INLINE_STYLE_ID = "wou-skills-pop-inline-style";
function injectInlineStyles() {
  if (document.getElementById(INLINE_STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = INLINE_STYLE_ID;
  s.textContent = `
    #wou-skills-pop {
      position: fixed;
      width: 420px;
      z-index: 9080;
      display: none;
      background: linear-gradient(180deg, rgba(10,9,8,0.97) 0%, rgba(10,9,8,0.94) 100%);
      border: 1px solid rgba(140,133,121,0.22);
      border-top: 1px solid rgba(110,82,36,0.55);
      box-shadow: 0 12px 36px rgba(0,0,0,0.85);
      font-family: var(--wdm-font-display, "PF DIN Text Cond Pro", sans-serif);
      font-size: 12px;
      color: var(--wdm-ink, #b0a994);
      pointer-events: auto;
      box-sizing: border-box;
      --arrow-x: 50%;
    }
    #wou-skills-pop .wou-sp-tabs {
      display: grid !important;
      grid-template-columns: repeat(8, 1fr);            /* JS overrides inline w/ live tab count */
      background: rgba(8,7,6,0.5);
      border-bottom: 1px dotted rgba(140,133,121,0.16);
    }
    #wou-skills-pop .wou-sp-tab {
      display: flex !important;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 1px;
      padding: 8px 0 7px 0 !important;
      min-height: 0 !important;
      height: auto !important;
      width: auto !important;
      background: none !important;
      border: none !important;
      border-radius: 0 !important;
      box-shadow: none !important;
      color: var(--wdm-ink-dim, #8c8579) !important;
      font-family: var(--wdm-font-display, inherit) !important;
      font-size: 10px !important;
      font-weight: 600 !important;
      letter-spacing: 0.14em !important;
      text-transform: uppercase !important;
      line-height: 1;
      cursor: pointer;
    }
    #wou-skills-pop .wou-sp-tab.is-active { color: var(--wdm-amber-bright, #d6a050) !important; }
    #wou-skills-pop .wou-sp-tab .val { font-size: 11px; font-weight: 700; }
    #wou-skills-pop .wou-sp-panel { display: none !important; }
    #wou-skills-pop .wou-sp-panel.is-active { display: block !important; }
    #wou-skills-pop .wou-sp-stat-head {
      display: grid;
      grid-template-columns: auto 1fr;
      align-items: center;
      gap: 12px;
      padding: 8px 12px;
      border-bottom: 1px dotted rgba(110,82,36,0.4);
    }
    #wou-skills-pop .wou-sp-stat-head .num {
      font-weight: 700; font-size: 22px;
      color: var(--wdm-amber-bright, #d6a050);
      min-width: 28px; text-align: center;
    }
    #wou-skills-pop .wou-sp-stat-head .nm {
      font-size: 12px; font-weight: 600;
      letter-spacing: 0.22em; text-transform: uppercase;
      color: var(--wdm-amber-hi, #c8a878);
    }
    #wou-skills-pop .wou-sp-skills {
      list-style: none;
      max-height: 220px;
      overflow-y: auto;
      padding: 4px 0;
      margin: 0;
    }
    #wou-skills-pop .wou-sp-skill {
      display: grid !important;
      grid-template-columns: 1fr auto auto;
      gap: 12px;
      align-items: baseline;
      padding: 4px 14px;
      font-size: 12px;
      cursor: pointer;
      list-style: none;
    }
    #wou-skills-pop .wou-sp-skill:hover { background: rgba(184,148,100,0.10); }
    #wou-skills-pop .wou-sp-skill .name { color: var(--wdm-ink, #b0a994); }
    #wou-skills-pop .wou-sp-skill .mod { color: var(--wdm-ink-faint, #6e6863); font-size: 10px; }
    #wou-skills-pop .wou-sp-skill.has-ae .mod { color: var(--wdm-amber-hi, #c8a878); font-style: italic; }
    #wou-skills-pop .wou-sp-skill.has-ae .total { text-shadow: 0 0 6px rgba(214,160,80,0.35); }
    #wou-skills-pop .wou-sp-skill .total {
      color: var(--wdm-amber-bright, #d6a050);
      font-weight: 700; font-size: 13px;
      min-width: 22px; text-align: right;
    }
    #wou-skills-pop .wou-sp-foot {
      padding: 6px 12px;
      font-size: 9px;
      letter-spacing: 0.20em;
      text-transform: uppercase;
      color: var(--wdm-ink-faint, #6e6863);
      text-align: center;
      border-top: 1px dotted rgba(140,133,121,0.16);
    }
  `;
  document.head.appendChild(s);
}

/* ─────────── popover DOM ─────────── */

function getPopover() {
  let pop = document.getElementById(POPOVER_ID);
  if (pop) return pop;
  pop = document.createElement("aside");
  pop.id = POPOVER_ID;
  pop.className = "wou-skills-pop";
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", "Skills");
  pop.dataset.open = "false";
  document.body.appendChild(pop);
  return pop;
}

function renderPopover(actor) {
  const pop = getPopover();
  if (!actor) {
    pop.innerHTML = `<div class="wou-sp-empty">— no character assigned —</div>`;
    return;
  }

  const catalog = buildSkillCatalog();
  const profData = buildProfessionTab(actor);
  /* If the user had Prof selected but the new actor has no profession, fall
   * back to ref so the popover doesn't open onto an empty tab. */
  if (_activeStat === "prof" && !profData) _activeStat = "ref";
  /* Defensive: also reset if _activeStat doesn't correspond to a real tab
   * (e.g. stale "luck" from before LUC was dropped). */
  if (_activeStat !== "prof" && !STATS.includes(_activeStat)) _activeStat = "ref";

  const tabCount = profData ? STATS.length + 1 : STATS.length;

  // stat tabs
  const statTabsHtml = STATS.map(stat => {
    const v = statValue(actor, stat);
    return `<button class="wou-sp-tab${stat === _activeStat ? " is-active" : ""}" type="button" data-stat="${stat}">${STAT_ABBR[stat]}<span class="val">${v}</span></button>`;
  }).join("");

  // profession tab (only when the actor has a profession with rollable skills)
  const profTabHtml = profData
    ? `<button class="wou-sp-tab wou-sp-tab-prof${_activeStat === "prof" ? " is-active" : ""}" type="button" data-stat="prof" title="${escapeHTML(profData.profession.name)}">PROF<span class="val">${profData.totalRollable}</span></button>`
    : "";

  // panels
  const panelsHtml = STATS.map(stat => {
    const sv = statValue(actor, stat);
    const label = statLabel(stat);
    const skills = catalog[stat] || [];

    let listHtml;
    if (skills.length === 0) {
      listHtml = `<li class="wou-sp-skill zero"><span class="name">— no skills under ${escapeHTML(STAT_LONG[stat])} —</span><span class="mod"></span><span class="total"></span></li>`;
    } else {
      listHtml = skills.map(sk => {
        const sd = actor.system?.skills?.[stat]?.[sk.name];
        const base = Number(sd?.value) || 0;
        /* `modifier` is the temporary adjustment from items/conditions
         * (schema: skills.mjs). Effective rank = base + modifier. */
        const modified = base + (Number(sd?.modifier) || 0);
        const aeBonus = modified - base;
        const total = sv + modified;
        const cls = modified >= 6 ? " maxed" : (modified === 0 ? " zero" : "");
        const aeFlag = aeBonus !== 0 ? ` has-ae` : "";
        const aeTitle = aeBonus !== 0 ? ` title="Base ${base}${aeBonus >= 0 ? " +" : " "}${aeBonus} from effects"` : "";
        const modStr = modified >= 0 ? `+${modified}` : `${modified}`;
        return `<li class="wou-sp-skill${cls}${aeFlag}" data-skill="${escapeHTML(sk.key)}"${aeTitle}>
          <span class="name">${escapeHTML(sk.label)}</span>
          <span class="mod">${modStr}</span>
          <span class="total">${total}</span>
        </li>`;
      }).join("");
    }

    return `<div class="wou-sp-panel${stat === _activeStat ? " is-active" : ""}" data-stat="${stat}">
      <div class="wou-sp-stat-head" data-stat="${stat}">
        <div class="num">${sv}</div>
        <div class="nm">${escapeHTML(label)}</div>
      </div>
      <ol class="wou-sp-skills">${listHtml}</ol>
    </div>`;
  }).join("");

  const profPanelHtml = profData ? renderProfessionPanel(profData, actor) : "";

  pop.innerHTML = `
    <div class="wou-sp-tabs" role="tablist" style="grid-template-columns: repeat(${tabCount}, 1fr);">${statTabsHtml}${profTabHtml}</div>
    ${panelsHtml}
    ${profPanelHtml}
    <div class="wou-sp-foot">
      Click <kbd>SKILL</kbd> = roll
    </div>`;
}

function renderProfessionPanel(profData, actor) {
  const active = _activeStat === "prof" ? " is-active" : "";
  const sectionsHtml = profData.sections.map(sec => {
    const rowsHtml = sec.skills.map(sk => {
      const stat = sk.stat;
      const sv = statValue(actor, stat);
      const lvl = Number(sk.level) || 0;
      const total = sv + lvl;
      const cls = lvl >= 6 ? " maxed" : "";
      const lvlStr = lvl >= 0 ? `+${lvl}` : `${lvl}`;
      const abbr = STAT_ABBR[stat] || String(stat).toUpperCase();
      return `<li class="wou-sp-skill${cls}" data-prof-skill="${escapeHTML(sk.skillName)}" title="${escapeHTML(sk.skillName)} (${abbr})">
        <span class="name">${escapeHTML(sk.skillName)} <span class="stat-tag">${abbr}</span></span>
        <span class="mod">${lvlStr}</span>
        <span class="total">${total}</span>
      </li>`;
    }).join("");
    return `<div class="wou-sp-prof-section ${sec.cls}">
      <div class="wou-sp-prof-section-head">${escapeHTML(sec.title)}</div>
      <ol class="wou-sp-skills">${rowsHtml}</ol>
    </div>`;
  }).join("");

  return `<div class="wou-sp-panel wou-sp-panel-prof${active}" data-stat="prof">
    <div class="wou-sp-prof-head"><div class="nm">${escapeHTML(profData.profession.name)}</div></div>
    ${sectionsHtml}
  </div>`;
}

/* ─────────── positioning ─────────── */

function positionAbove(triggerEl) {
  const pop = getPopover();
  const rect = triggerEl.getBoundingClientRect();
  // Force layout so we can read pop's width
  pop.style.visibility = "hidden";
  pop.style.display = "block";
  const popRect = pop.getBoundingClientRect();
  const popW = popRect.width || 420;
  const popH = popRect.height || 290;

  /* Always reserve the right 436px for the sidebar's footprint so the
     popover never ends up under it — open or closed. Measure the actual
     #sidebar bounding-rect when present so we cover both states + custom
     widths gracefully; fall back to 436px when sidebar isn't in the DOM. */
  const sidebarEl = document.getElementById("sidebar");
  let sidebarLeftEdge = window.innerWidth;
  if (sidebarEl) {
    const sr = sidebarEl.getBoundingClientRect();
    if (sr.width > 0) sidebarLeftEdge = Math.min(sidebarLeftEdge, sr.left);
  }
  const reservedRight = Math.max(0, window.innerWidth - sidebarLeftEdge, 436);
  const rightLimit = window.innerWidth - reservedRight - 8;
  const leftLimit = 8;

  /* Try to center on trigger, but clamp into the available canvas band */
  let left = rect.left + rect.width / 2 - popW / 2;
  left = Math.max(leftLimit, Math.min(left, rightLimit - popW));
  /* If the canvas band can't even fit the popover (narrow viewport),
     just pin to leftLimit and let the user scroll/resize. */
  if (rightLimit - popW < leftLimit) left = leftLimit;
  const bottom = window.innerHeight - rect.top + 14;          /* 14px gap above the sign */

  pop.style.left = `${left}px`;
  pop.style.bottom = `${bottom}px`;
  pop.style.visibility = "";

  // arrow x relative to popover's left edge — clamped to the popover's bounds
  let arrowX = rect.left + rect.width / 2 - left;
  arrowX = Math.max(20, Math.min(arrowX, popW - 20));
  pop.style.setProperty("--arrow-x", `${arrowX}px`);
}

/* ─────────── show / hide ─────────── */

function isOpen() {
  const pop = document.getElementById(POPOVER_ID);
  return pop?.dataset.open === "true";
}

/** Active actor: assigned > selected token > first owned character. */
function getActiveActor() {
  const u = game?.user;
  if (u?.character) return u.character;
  const selected = canvas?.tokens?.controlled?.[0]?.actor;
  if (selected) return selected;
  const owned = game?.actors?.find?.(a => a.isOwner && a.type === "character");
  return owned ?? null;
}

function open(triggerEl) {
  const actor = getActiveActor();
  if (!actor) {
    ui.notifications?.warn("Witcher Overhaul UI: select a token or assign a character.");
    return;
  }
  renderPopover(actor);
  const pop = getPopover();
  pop.dataset.open = "true";
  positionAbove(triggerEl);
  /* Use setProperty with `important` so nothing else can keep the popover
     stuck at display:none. */
  pop.style.setProperty("display", "block", "important");
  pop.style.setProperty("z-index", "9080", "important");
  pop.style.setProperty("opacity", "1", "important");
  pop.style.setProperty("visibility", "visible", "important");
  document.querySelectorAll('#wou-dock .sign[data-action="skills"]').forEach(s => s.classList.add("is-active"));
}

function close() {
  const pop = document.getElementById(POPOVER_ID);
  if (!pop) return;
  pop.dataset.open = "false";
  pop.style.setProperty("display", "none", "important");
  document.querySelectorAll('#wou-dock .sign[data-action="skills"]').forEach(s => s.classList.remove("is-active"));
}

function toggle(triggerEl) {
  if (isOpen()) close();
  else open(triggerEl);
}

/* ─────────── rolling ─────────── */

async function rollSkill(actor, skillKey) {
  try {
    if (typeof actor.rollSkill === "function") {
      await actor.rollSkill(skillKey);
    } else {
      ui.notifications?.warn("No rollSkill on actor.");
    }
  } catch (e) {
    console.warn(`${MODULE_ID} | rollSkill ${skillKey} failed`, e);
  }
}

/* Resolve a profession sub-skill by its display name to the live slot on the
 * profession item ({ skillName, stat, level }). The panel rows only carry the
 * name, so resolve it to the live slot via the system helper first. */
async function rollProfessionSkill(actor, skillName) {
  try {
    if (typeof actor.rollProfessionSkill !== "function" || typeof actor.findProfessionSlot !== "function") {
      ui.notifications?.warn("Actor does not support profession skills.");
      return;
    }
    const slot = actor.findProfessionSlot(skillName);
    if (!slot) {
      ui.notifications?.warn(`Profession skill "${skillName}" not found.`);
      return;
    }
    await actor.rollProfessionSkill(slot);
  } catch (e) {
    console.warn(`${MODULE_ID} | rollProfessionSkill ${skillName} failed`, e);
  }
}

/* ─────────── event wiring ─────────── */

function onClick(e) {
  // 1. Skills sign in the dock → toggle
  const sign = e.target.closest('#wou-dock .sign[data-action="skills"]');
  if (sign) {
    e.preventDefault();
    e.stopPropagation();
    toggle(sign);
    return;
  }

  const pop = document.getElementById(POPOVER_ID);
  if (!pop || pop.dataset.open !== "true") return;

  // 2. Click outside popover → close
  if (!pop.contains(e.target)) {
    close();
    return;
  }

  // 3. Tab switch
  const tab = e.target.closest(".wou-sp-tab");
  if (tab) {
    e.preventDefault();
    _activeStat = tab.dataset.stat;
    pop.querySelectorAll(".wou-sp-tab").forEach(t => t.classList.toggle("is-active", t === tab));
    pop.querySelectorAll(".wou-sp-panel").forEach(p => p.classList.toggle("is-active", p.dataset.stat === _activeStat));
    return;
  }

  // 4. Profession-skill row click → dispatch via professionMixin
  const profSkill = e.target.closest(".wou-sp-skill[data-prof-skill]");
  if (profSkill) {
    e.preventDefault();
    const actor = getActiveActor();
    if (actor) rollProfessionSkill(actor, profSkill.dataset.profSkill);
    return;
  }

  // 5. Skill row click → roll skill
  const skill = e.target.closest(".wou-sp-skill[data-skill]");
  if (skill) {
    e.preventDefault();
    const actor = getActiveActor();
    if (actor) rollSkill(actor, skill.dataset.skill);
    return;
  }
}

function onKeydown(e) {
  if (e.key !== "Escape") return;
  if (isOpen()) close();
}

function onResize() {
  if (!isOpen()) return;
  const trigger = document.querySelector('#wou-dock .sign[data-action="skills"]');
  if (trigger) positionAbove(trigger);
}

/* ─────────── public setup ─────────── */

export function setupSkillsPanel() {
  if (_wired) return;
  _wired = true;
  injectInlineStyles();                                      /* guaranteed structural CSS, no external file dep */
  getPopover();                                              /* create the empty popover element early */
  document.addEventListener("click", onClick, true);         /* capture so we beat dock's own listeners */
  document.addEventListener("keydown", onKeydown);
  window.addEventListener("resize", onResize, { passive: true });
  /* Re-render on actor / item changes so values stay live while open */
  const ownsMine = (item) => item?.parent?.id === game.user?.character?.id;
  /* Coalesce: many hooks in the same tick → at most one render per
   * animation frame, gated on the popover being open. */
  let _pending = false;
  const rerenderIfOpen = () => {
    if (_pending) return;
    if (!isOpen()) return;
    _pending = true;
    requestAnimationFrame(() => {
      _pending = false;
      if (!isOpen()) return;
      const a = getActiveActor();
      if (a) renderPopover(a);
    });
  };
  Hooks.on("updateActor", (actor) => { if (actor.id === game.user?.character?.id) rerenderIfOpen(); });
  Hooks.on("createItem",  (item)  => { if (ownsMine(item)) rerenderIfOpen(); });
  Hooks.on("updateItem",  (item)  => { if (ownsMine(item)) rerenderIfOpen(); });
  Hooks.on("deleteItem",  (item)  => { if (ownsMine(item)) rerenderIfOpen(); });
}
