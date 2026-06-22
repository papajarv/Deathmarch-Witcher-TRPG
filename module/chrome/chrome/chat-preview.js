/**
 * Chat-card previews above the dock.
 *
 * When a new ChatMessage fires and the chat tab isn't currently visible,
 * inject a styled preview pill into the existing #notifications strip
 * (which is already pinned above the dock and themed in chrome.css).
 * The pill auto-dismisses after a few seconds or on click.
 *
 * We don't fight Foundry's queue — these <li>s sit in the same <ol> but
 * the queue's internal `#active` map only tracks entries it created, so
 * extras are invisible to it.
 */

const PREVIEW_LIFETIME_MS = 11000;
const PREVIEW_MAX_LEN     = 600;

/* Body classes set while a full-screen chrome overlay is open. A chat preview
 * shares the #notifications strip with Foundry's warnings, which paints above
 * these overlays — so while one is open the preview would float over it. Only
 * the actual ui.notifications warnings should overlay; chat previews are
 * suppressed (the message still lands in the chat log). */
const CHROME_OVERLAY_CLASSES = [
  "wou-inventory-open", "wou-character-open", "wou-crafting-open",
  "wou-bestiary-open", "wou-journal-open", "wou-map-open"
];

/** True while any full-screen chrome overlay is open. */
function isChromeOverlayOpen() {
  return CHROME_OVERLAY_CLASSES.some(c => document.body.classList.contains(c));
}

/** True if the chat tab is the active sidebar tab AND the sidebar is
 *  expanded.  Foundry v13's sidebar exposes the active primary tab as
 *  `ui.sidebar.tabGroups.primary` and its expanded state as a getter on
 *  `ui.sidebar.expanded` — neither of the older `activeTab`/`tabName`
 *  names exists. */
function isChatVisible() {
  const sidebar = ui.sidebar;
  if (!sidebar?.expanded) return false;
  return sidebar.tabGroups?.primary === "chat";
}

/** Mirror Foundry's intended visibility rules for the chat log — but DON'T
 *  rely on `message.visible`, which short-circuits to true for any roll
 *  inside a whisper (chat-message.mjs:104).  That short-circuit was leaking
 *  whisper-rolls and blind-rolls into the preview for users who shouldn't
 *  see them. */
function userCanSeeMessage(message) {
  if (!message) return false;
  const me     = game.userId;
  const isGM   = !!game.user?.isGM;

  /* Author id — `author` is the v13 canonical, `user` is the legacy field. */
  const authorId = message.author?.id ?? (typeof message.user === "string" ? message.user : message.user?.id);
  const isAuthor = typeof authorId === "string" && authorId === me;

  /* Blind rolls: visible only to the GM (and the author for some
   * configurations, but the canonical behavior hides the actual roll
   * from everyone except the GM).  Players never preview a blind roll. */
  if (message.blind && !isGM) return false;

  /* Whispered messages: visible to recipients, author, and (by default
   * Foundry behavior) the GM.  Anyone else can't preview the content. */
  const whisper = Array.isArray(message.whisper) ? message.whisper : [];
  if (whisper.length > 0) {
    if (isGM)               return true;
    if (isAuthor)           return true;
    return whisper.includes(me);
  }

  return true;
}

/** Best-effort sender label — character alias when speaking in-character,
 *  user name otherwise.  Trimmed to a sensible chip length. */
function senderLabel(message) {
  const raw = message?.alias
           || message?.speaker?.alias
           || message?.author?.name
           || game.i18n?.localize?.("CHAT.Unknown")
           || "Unknown";
  return String(raw).slice(0, 24);
}

/* Tags whose visible text is interactive chrome (button labels, image
 * alt-text, hidden inputs, etc.) rather than meaningful content.  We
 * strip them before extracting textContent so e.g. the system's
 * <button class="damage">Damage</button> on attack flavors doesn't
 * leak into the preview. */
const STRIP_TAGS = ["button", "input", "select", "textarea", "script", "style", "img"];

/** Strip HTML, normalize whitespace, truncate. */
function flattenContent(html) {
  if (!html) return "";
  const tmp = document.createElement("div");
  tmp.innerHTML = String(html);
  for (const tag of STRIP_TAGS) {
    tmp.querySelectorAll(tag).forEach(el => el.remove());
  }
  let text = (tmp.textContent || "").replace(/\s+/g, " ").trim();
  if (text.length > PREVIEW_MAX_LEN) text = text.slice(0, PREVIEW_MAX_LEN - 1) + "…";
  return text;
}

/* The Witcher system wraps combat-card HTML in .attack-message /
 * .defense-message / .damage-message containers whose <h1> is the actual
 * headline (e.g. "Attack: Steel Sword").  Surrounding <span>s repeat
 * derived info ("Location: Torso") that's noisier than helpful in a
 * truncated preview.  Pull the headline if we see one; otherwise fall
 * back to the full flattened text. */
function extractSystemHeadline(html) {
  if (!html) return "";
  const tmp = document.createElement("div");
  tmp.innerHTML = String(html);
  const card = tmp.querySelector(".attack-message, .defense-message, .damage-message");
  if (!card) return "";
  const head = card.querySelector("h1, h2");
  if (!head) return "";
  for (const tag of STRIP_TAGS) head.querySelectorAll(tag).forEach(el => el.remove());
  return (head.textContent || "").replace(/\s+/g, " ").trim();
}

/* Recognize the system's skill / profession roll cards (skillMixin builds
 * a `.wdm-skill-head` header + extendedRoll builds a `.wdm-roll` dice body).
 * Flattening them to plain text produces an unreadable run, so pull the
 * pieces out structurally and let the preview lay them out properly.
 * Returns null for any message that isn't one of our roll cards. */
function extractSkillCard(message) {
  const html = message?.content;
  if (!html) return null;
  const tmp = document.createElement("div");
  tmp.innerHTML = String(html);
  const head = tmp.querySelector(".wdm-skill-head");
  const roll = tmp.querySelector(".wdm-roll");
  if (!head && !roll) return null;

  const txt = (el) => (el?.textContent || "").replace(/\s+/g, " ").trim();
  const skillName = txt(head?.querySelector(".wdm-skill-name"));
  const sub       = txt(head?.querySelector(".wdm-skill-sub"));
  const chips = Array.from(head?.querySelectorAll(".wdm-chip") ?? []).map(c => {
    const k = txt(c.querySelector(".wdm-chip-k"));
    const v = txt(c.querySelector(".wdm-chip-v"));
    return [k, v].filter(Boolean).join(" ");
  }).filter(Boolean);

  let dice = "", total = "";
  const line = roll?.querySelector(".wdm-roll-line");
  if (line) {
    const dieVals = Array.from(line.querySelectorAll(".wdm-roll-dice > span"))
      .map(s => txt(s)).filter(Boolean).join(" ");
    const mod = txt(line.querySelector(".wdm-roll-mod"));
    dice  = ["d10", dieVals, mod].filter(Boolean).join(" ");
    total = txt(line.querySelector(".wdm-roll-total"));
  }

  let verdict = null;
  const res = roll?.querySelector(".wdm-roll-result");
  if (res) {
    verdict = {
      pass: res.classList.contains("pass"),
      dc:   txt(res.querySelector(".wdm-roll-dc")),
      text: txt(res.querySelector(".wdm-roll-verdict"))
    };
  }

  return { skillName, sub, chips, dice, total, verdict };
}

function buildPreviewElement(message) {
  const li = document.createElement("li");
  li.classList.add("notification", "wou-chat-preview");
  /* Tag with the source message id so the updateMessage hook can find
   * + re-sync this preview when the underlying chat card mutates
   * (damage button consumed, crit wound appended, etc.). */
  li.dataset.wouMsgId = message.id;

  /* Whisper detection — paints the stripe frost-blue to match the chat
   * tab's .whisper-to color, so a private message reads as private even
   * in the preview. */
  if (Array.isArray(message.whisper) && message.whisper.length) {
    li.classList.add("is-whisper");
  }

  /* Subtitle: prefer the system's combat-card headline when present
   * (clean "Attack: Steel Sword"), otherwise fall back to the full
   * flattened flavor.  Either way, buttons / inputs / images are
   * already stripped. */
  const headline   = extractSystemHeadline(message.flavor);
  const flavorText = flattenContent(message.flavor);
  const bodyText   = flattenContent(message.content);
  let subtitle     = headline || ((flavorText && bodyText && flavorText !== bodyText) ? flavorText : "");
  let primary      = bodyText || (headline ? flavorText : "") || flavorText || "(empty message)";

  /* Roll formulas — each Roll on the message contributes a "formula = total"
   * line.  We pluck total + formula off each roll; the rendered preview
   * shows them as small monospace lines below the body so the player can
   * see both the math and the result without expanding the real card. */
  const rollLines = [];
  const rolls = message.rolls ?? (message.roll ? [message.roll] : []);
  for (const r of rolls) {
    const total   = r?.total ?? r?._total;
    const formula = r?.formula ?? r?._formula;
    if (Number.isFinite(total) && formula) {
      rollLines.push({ formula: String(formula), total: String(total) });
    } else if (Number.isFinite(total)) {
      rollLines.push({ formula: "", total: String(total) });
    }
  }

  /* Real DOM beats ::after pseudo for the sender chip — gives us a proper
   * flex item so the rest of the card can use a stable two-column layout
   * (sender on the left, text stack on the right) without the chip ever
   * being clipped by the parent's `overflow: hidden`. */
  const esc = (s) => foundry.utils?.escapeHTML?.(s) ?? s;

  /* Skill / profession roll card → tailored layout: skill name (+ kind) as
   * the subtitle, stat/rank chips as the body line, the dice math as a
   * single roll line, and a coloured pass/fail badge for DC checks. */
  const skillCard = extractSkillCard(message);
  let verdictHtml = "";
  if (skillCard) {
    li.classList.add("is-skill-roll");
    subtitle = [skillCard.skillName, skillCard.sub].filter(Boolean).join(" · ") || subtitle;
    primary  = skillCard.chips.length ? skillCard.chips.join("   ·   ") : "";
    rollLines.length = 0;
    if (skillCard.dice || skillCard.total) {
      rollLines.push({ formula: skillCard.dice, total: skillCard.total });
    }
    if (skillCard.verdict) {
      verdictHtml = `<div class="wou-chat-preview-verdict ${skillCard.verdict.pass ? "pass" : "fail"}">`
        + (skillCard.verdict.dc ? `<span class="dc">${esc(skillCard.verdict.dc)}</span>` : "")
        + `<span class="v">${esc(skillCard.verdict.text)}</span></div>`;
    }
  }

  const rollsHtml = rollLines.length
    ? `<div class="wou-chat-preview-rolls">
         ${rollLines.map(r =>
           r.formula
             ? `<div class="wou-chat-preview-roll"><span class="formula">${esc(r.formula)}</span><span class="eq">=</span><span class="total">${esc(r.total)}</span></div>`
             : `<div class="wou-chat-preview-roll"><span class="total">${esc(r.total)}</span></div>`
         ).join("")}
       </div>`
    : "";

  /* Attack-card messages have a self-describing one-liner summary
   * (the `<summary class="wdm-attack-card-summary">` chips: verdict,
   * location, damage, status, crit, stress). When present, just
   * MIRROR that into the preview — the user explicitly wants the
   * middle-screen bar to echo the chat card's summary verbatim
   * instead of having its own subtitle/primary/verdict rendering.
   * Falls back to the legacy preview body for non-attack messages. */
  const attackSummaryHtml = extractAttackCardSummaryHtml(message);
  if (attackSummaryHtml) {
    li.innerHTML = `
      <span class="wou-chat-preview-sender">${esc(senderLabel(message))}</span>
      <div class="wou-chat-preview-text wou-chat-preview-mirror">
        <div class="wou-chat-preview-summary">${attackSummaryHtml}</div>
      </div>
    `;
  } else {
    li.innerHTML = `
      <span class="wou-chat-preview-sender">${esc(senderLabel(message))}</span>
      <div class="wou-chat-preview-text">
        ${subtitle ? `<div class="wou-chat-preview-subtitle">${esc(subtitle)}</div>` : ""}
        ${primary ? `<p>${esc(primary)}</p>` : ""}
        ${rollsHtml}
        ${verdictHtml}
        <!-- Action buttons get appended here after construction. -->
      </div>
    `;
  }

  /* Mirror action buttons from the real chat-message — clicking a preview
   * button forwards to the live button in #chat-log so the system's
   * existing renderChatMessageHTML-bound handlers fire as-is.  For
   * attack cards we extract the summary's in-line action slot button
   * (Roll Damage) which is also already in the message content. */
  appendActionButtons(li, message);

  /* Clicking the card itself (anywhere outside an action button) just
   * dismisses the preview — it does NOT open the chat tab. */
  li.addEventListener("click", (ev) => {
    if (ev.target.closest(".wou-chat-preview-action")) return;
    li.remove();
  });
  return li;
}

/** Extract <button> elements from the message's flavor + content, clone them
 *  into the preview, and wire each clone's click to the matching live button
 *  in #chat-log so the system's bound handler fires. */
function appendActionButtons(li, message) {
  const sources = [];
  /* Dedupe by data-action — the attack card sometimes has the SAME
   * action button in two places (the body's .wdm-attack-damage and
   * the summary action slot). One preview proxy per logical action
   * is enough. */
  const seenActions = new Set();
  for (const html of [message.flavor, message.content]) {
    if (!html) continue;
    const tmp = document.createElement("div");
    tmp.innerHTML = String(html);
    tmp.querySelectorAll("button").forEach((b, i) => {
      const action = b.dataset.action || "";
      if (action && seenActions.has(action)) return;
      if (action) seenActions.add(action);
      sources.push({ btn: b, index: i, label: (b.textContent || "").trim() });
    });
  }
  if (!sources.length) return;

  const row = document.createElement("div");
  row.className = "wou-chat-preview-actions";

  sources.forEach((src, n) => {
    const proxy = document.createElement("button");
    proxy.type = "button";
    proxy.className = "wou-chat-preview-action";
    proxy.textContent = src.label || `Action ${n + 1}`;
    /* Stash enough info to find the live button later: message id, original
     * class list, and a within-message ordinal as a tiebreaker. */
    proxy.dataset.wouMsgId = message.id;
    proxy.dataset.wouBtnIdx = String(n);
    if (src.btn.className) proxy.dataset.wouBtnClass = src.btn.className;

    proxy.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const live = findLiveButton(message.id, n, src.btn.className);
      if (live) {
        live.click();
        /* One-shot sync: a damage button is consumed after a single
         * click (data-consumed = "1" set by rollDamageFromButton).
         * Once consumed, the proxy should vanish from the preview so
         * the user can't try to re-fire it from here. Same logic for
         * any other "consumed" button pattern (defense buttons that
         * get re-rendered out of the card). */
        setTimeout(() => {
          const stillLive = findLiveButton(message.id, n, src.btn.className);
          if (!stillLive || stillLive.dataset.consumed === "1" || stillLive.disabled) {
            proxy.remove();
            /* If no proxies left, drop the whole row. */
            if (!row.querySelector("button")) row.remove();
          }
        }, 50);
      } else {
        /* Live button is gone — most likely consumed already from the
         * chat tab. Remove the stale proxy so the preview stays in
         * sync with the actual card state. */
        proxy.remove();
        if (!row.querySelector("button")) row.remove();
      }
    });

    row.appendChild(proxy);
  });

  li.querySelector(".wou-chat-preview-text")?.appendChild(row);
}

/** Find the Nth button matching the given class set within the live chat
 *  message DOM.  Falls back to "Nth button overall" if class-matching
 *  yields nothing. */
function findLiveButton(messageId, ordinal, className) {
  if (!messageId) return null;
  const card = document.querySelector(`#chat-log li.chat-message[data-message-id="${messageId}"], #chat .chat-message[data-message-id="${messageId}"]`);
  if (!card) return null;
  const all = Array.from(card.querySelectorAll("button"));
  if (!all.length) return null;
  if (className) {
    const matching = all.filter(b => b.className === className);
    if (matching.length) return matching[Math.min(ordinal, matching.length - 1)];
  }
  return all[Math.min(ordinal, all.length - 1)];
}

function showPreviewFor(message) {
  /* Privacy gate FIRST — never spawn a preview the user wouldn't see in
   * the actual chat log.  Foundry's `message.visible` is unreliable for
   * roll-bearing whispers (returns true for any whisper containing a
   * Roll), so we re-derive visibility from whisper/blind directly. */
  if (!userCanSeeMessage(message)) return;
  /* If the chat tab is already on-screen there's no value add — the
   * actual chat message will render right where the user is looking. */
  if (isChatVisible()) return;
  /* Don't float a preview over a full-screen chrome overlay (inventory,
   * character, bestiary, …) — only Foundry warnings should overlay those. */
  if (isChromeOverlayOpen()) return;

  const list = previewContainer();
  if (!list) return;

  const li = buildPreviewElement(message);
  list.prepend(li);   /* with the strip's column-reverse, prepend = newest visible at the bottom */
  setTimeout(() => li.remove(), PREVIEW_LIFETIME_MS);
}

/* The previews get their OWN <ol> rather than sharing Foundry's
 * #notifications strip so chrome.css can give them a LOW z-index that
 * layers them behind every piece of UI (bars, dialogs, chrome overlays)
 * while still floating over the scene — the real strip keeps its high
 * z-index so warnings stay on top. The container is appended to <body>
 * (not #interface) so it lives in the root stacking context, the same one
 * the board and UI bars compete in; that's what lets a plain z-index order
 * it relative to them. Created lazily on the first preview and reused
 * thereafter; it inherits positioning/styling via the shared :is()
 * selectors in chrome.css, only its z-index differs. */
function previewContainer() {
  let el = document.getElementById("wdm-chat-previews");
  if (!el) {
    el = document.createElement("ol");
    el.id = "wdm-chat-previews";
    document.body.appendChild(el);
  }
  return el;
}

/** Pull the inner HTML of `<summary class="wdm-attack-card-summary">`
 *  from a message's content, if it carries one. Returns the chip HTML
 *  ready to drop into the preview as-is — same chevron/chips/styling
 *  the chat card uses, so the preview reads as a 1:1 echo of the
 *  collapsed chat one-liner. Excludes the trailing action slot
 *  (`.wdm-card-sum-action`) which is handled by appendActionButtons. */
function extractAttackCardSummaryHtml(message) {
    const content = String(message?.content ?? "");
    if (!content.includes("wdm-attack-card-summary")) return null;
    const tmp = document.createElement("div");
    tmp.innerHTML = content;
    const summary = tmp.querySelector("summary.wdm-attack-card-summary");
    if (!summary) return null;
    /* Strip the action slot — buttons go in their own row via
     * appendActionButtons. Keep crosshair icon + chips + separators. */
    const clone = summary.cloneNode(true);
    clone.querySelectorAll(".wdm-card-sum-action").forEach(n => n.remove());
    return clone.innerHTML;
}

/** Find any open preview <li>s for a given message id. */
function previewsFor(messageId) {
  const list = document.getElementById("wdm-chat-previews");
  if (!list) return [];
  return Array.from(list.querySelectorAll(`li[data-wou-msg-id="${CSS.escape(messageId)}"]`));
}

/** Sync an existing preview's body to the latest message state.
 *
 * Called from updateMessage so the floating preview reflects:
 *   - Damage button consumed (chip removed once rollDamageFromButton
 *     strips it from the chat content)
 *   - Newly appended consequences (crit wound, status riders, stress)
 *     that other contributors fold into the attack card via
 *     appendAttackResult
 *
 * Strategy: re-derive the action buttons row + the verdict/rolls
 * text from the live message, then swap them into the preview. The
 * sender + subtitle stay (they don't change post-creation). */
function syncPreviewToMessage(message) {
  const previews = previewsFor(message.id);
  if (!previews.length) return;
  /* If the message NOW has an attack-card summary, that's what we
   * want to show — even if the preview was originally built (on
   * createChatMessage) before appendAttackResult wrapped the content.
   * Re-extract once per call and reuse across all matching previews. */
  const newSummaryHtml = extractAttackCardSummaryHtml(message);
  for (const li of previews) {
    const textBox = li.querySelector(".wou-chat-preview-text");
    if (newSummaryHtml !== null && textBox) {
      /* Wipe the legacy body (subtitle/primary/rolls/verdict) and
       * replace with the mirror block. Idempotent: if a mirror is
       * already there, it just gets re-rendered with fresh chips. */
      textBox.classList.add("wou-chat-preview-mirror");
      textBox.innerHTML = `<div class="wou-chat-preview-summary">${newSummaryHtml}</div>`;
    }
    /* Strip the old action row + rebuild from current content. */
    li.querySelector(".wou-chat-preview-actions")?.remove();
    try { appendActionButtons(li, message); }
    catch (_) { /* preview structure changed under us — ignore */ }
  }
}

export function installChatPreviews() {
  Hooks.on("createChatMessage", showPreviewFor);
  /* Keep the floating preview in sync with the underlying message:
   * if the attack card grows or its damage button is consumed, the
   * preview should reflect that without waiting for its 11-second
   * auto-dismiss. */
  /* Foundry's hook name for ChatMessage updates is `updateChatMessage`
   * (follows the `update<DocumentName>` convention) — `updateMessage`
   * never fires for chat messages and the preview stayed stale. */
  Hooks.on("updateChatMessage", (message) => syncPreviewToMessage(message));
}
