/**
 * Sidebar vertical clamp.
 *
 * The sidebar's bottom edge should butt cleanly against the top of #wou-dock
 * regardless of peace / combat mode. The dock's height varies per mode and
 * also flexes with content, so static values (160 / 230) drift in both
 * directions. Measure the dock directly and publish a single CSS variable
 * `--wdm-sidebar-bottom-clamp` that sidebar.css consumes.
 *
 * Uses ResizeObserver on #wou-dock so any height change (combat transition,
 * adrenaline counter rendering, custom content) flows through automatically.
 */

let _observer = null;

function publish() {
  const dock = document.getElementById("wou-dock");
  if (!dock) return;
  const h = dock.getBoundingClientRect().height;
  if (h <= 0) return;
  /* Dock's box top = visible top edge of the dock. Combat content that
     "overflows above" the dock box is INSIDE the sidebar's vertical range
     either way — we just need the icon strip to actually fit (sized in CSS),
     not the clamp to swallow more vertical space. */
  document.documentElement.style.setProperty("--wdm-sidebar-bottom-clamp", `${h}px`);
  document.body.dataset.wouSidebarClamp = `${Math.round(h)}px`;
}

let _rafId = 0;
/* Coalesce bursts of triggers (resize + ResizeObserver + a combat hook all
   firing in the same frame) into ONE measure per frame — a single forced
   reflow, never N. Replaces the old publishBurst(), which polled publish()
   8×60ms on every trigger (8 forced reflows over ~480ms) and, worse, ran on
   EVERY body-class mutation. The dock's height changes — combat-transition
   animation frames, adrenaline counter, custom content — are caught by the
   ResizeObserver instead, so no poll and no class observer is needed. */
function schedulePublish() {
  if (_rafId) return;
  _rafId = requestAnimationFrame(() => {
    _rafId = 0;
    publish();
  });
}

export function wireSidebarClamp() {
  if (_observer) return;

  // Initial publish — fire several times because the dock's final height
  // settles after fonts load + after the bottom-strip painter resolves the
  // first repaint. Cheap to over-fire.
  publish();
  requestAnimationFrame(publish);
  setTimeout(publish, 100);
  setTimeout(publish, 500);
  setTimeout(publish, 1500);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(publish);

  const dock = document.getElementById("wou-dock");
  if (dock && "ResizeObserver" in window) {
    /* PRIMARY driver: any dock height change flows through here — combat
       transition animation frames, adrenaline counter rendering, custom
       content. This is why the old 8×60ms poll and the body-class
       MutationObserver (which re-measured on every unrelated class flip)
       were removed: the RO already sees every real height change. */
    _observer = new ResizeObserver(schedulePublish);
    _observer.observe(dock);
  }
  window.addEventListener("resize", schedulePublish, { passive: true });

  // Combat hooks — semantic triggers for a dock layout switch. Coalesced to a
  // single per-frame measure; the RO above catches the animated height change
  // and the *-end listeners below catch the settle, so this stays cheap even
  // for players not in the combat.
  for (const hook of ["createCombat", "deleteCombat", "updateCombat", "combatStart", "combatTurn", "combatRound"]) {
    Hooks.on(hook, schedulePublish);
  }
  // The combat-in keyframe settles after ~350ms, the leaving fade after ~350ms.
  document.body.addEventListener("transitionend", schedulePublish, { passive: true });
  document.body.addEventListener("animationend", schedulePublish, { passive: true });
}
