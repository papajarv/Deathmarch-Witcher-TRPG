/**
 * Sidebar — Chat tab DOM enhancements.
 *
 * Foundry's chat tab is a flat list of <li class="chat-message"> with a
 * header row + content. The Vladimir mockup adds two things our restyle
 * can't do via CSS alone:
 *
 *   1. A `.sb-head` title bar at the top of the chat panel
 *      (comments-icon mark + "Chat" title + All/Rolls/IC/Whispers chips)
 *   2. A small `.sb-ava` portrait bubble on the left of every message
 *
 * Both are pure cosmetic injections. The subnav chips are visual-only for
 * now — they don't filter messages.
 */

import { MODULE_ID } from "../setup/settings.js";

/* -------------------------------------------------------------------------- */
/*  Header                                                                    */
/* -------------------------------------------------------------------------- */

const HEAD_ID = "wou-chat-head";
const HEAD_HTML = `
<div id="${HEAD_ID}" class="sb-head">
  <div class="title-row">
    <span class="title-mark"><i class="fa-solid fa-comments"></i></span>
    <h2 class="sb-title">Chat</h2>
  </div>
  <div class="sb-subnav">
    <button class="sub-chip is-active" type="button" data-filter="all"><i class="fa-solid fa-globe"></i>All</button>
    <button class="sub-chip" type="button" data-filter="rolls"><i class="fa-solid fa-dice-d20"></i>Rolls</button>
    <button class="sub-chip" type="button" data-filter="ic"><i class="fa-solid fa-comment-dots"></i>IC</button>
    <button class="sub-chip" type="button" data-filter="whispers"><i class="fa-solid fa-user-secret"></i>Whispers</button>
  </div>
</div>`;

function injectChatHeader() {
  const chatRoot = document.getElementById("chat");
  if (!chatRoot) return;
  if (chatRoot.querySelector(`#${HEAD_ID}`)) return;          // idempotent
  chatRoot.insertAdjacentHTML("afterbegin", HEAD_HTML);
  if (!chatRoot.dataset.wouFilter) chatRoot.dataset.wouFilter = "all";
}

/* Document-level click delegation for the subnav chips. Survives any number
   of header re-injections because the listener lives on document.body, not
   on the chip DOM. Installed once. */
let _filterListenerInstalled = false;
function installFilterListener() {
  if (_filterListenerInstalled) return;
  _filterListenerInstalled = true;
  document.addEventListener("click", (e) => {
    const chip = e.target.closest(`#${HEAD_ID} .sub-chip`);
    if (!chip) return;
    e.preventDefault();
    const chatRoot = document.getElementById("chat");
    if (!chatRoot) return;
    chatRoot.querySelectorAll(`#${HEAD_ID} .sub-chip`).forEach(c => c.classList.toggle("is-active", c === chip));
    chatRoot.dataset.wouFilter = chip.dataset.filter || "all";
    markMessageTypes();
  });
}

/* -------------------------------------------------------------------------- */
/*  Speak-as mode toggle (OOC / IC / Emote / Whisper-to-GM)                   */
/* -------------------------------------------------------------------------- */

let _chatMode = "ic";

function injectChatModeButtons() {
  const controls = document.getElementById("chat-controls");
  if (!controls) return;
  if (controls.querySelector(".wou-chat-modes")) return;          // idempotent

  const modes = document.createElement("div");
  modes.className = "wou-chat-modes";
  // GM-whisper is intentionally omitted here — the native #message-modes
  // buttons to the right already cover Whisper-to-GM (and Blind/Self).
  modes.innerHTML = `
    <button type="button" class="wou-mode" data-mode="ooc"   aria-pressed="${_chatMode === "ooc"}"   data-tooltip="Speak as: OOC (out of character)">OOC</button>
    <button type="button" class="wou-mode" data-mode="ic"    aria-pressed="${_chatMode === "ic"}"    data-tooltip="Speak as: IC (in character)">IC</button>`;
  controls.insertBefore(modes, controls.firstChild);

  modes.addEventListener("click", (e) => {
    const btn = e.target.closest(".wou-mode");
    if (!btn) return;
    e.preventDefault();
    _chatMode = btn.dataset.mode || "ooc";
    syncCoreMessageMode(_chatMode);
    modes.querySelectorAll(".wou-mode").forEach(b =>
      b.setAttribute("aria-pressed", b === btn ? "true" : "false")
    );
  });
}

/* The OOC branch of the chatMessage hook defers plain text to Foundry, which
 * routes it by core.messageMode. If that's left on "ic" (e.g. from a prior
 * session), OOC messages post as IC. Point core.messageMode at the chosen chrome
 * mode so OOC stays OOC. This does NOT touch the native #message-modes buttons
 * (Public/GM/Blind/Self) — both just write the same client setting. */
const CORE_MODE = { ooc: "public", ic: "ic", gm: "gm" };
function syncCoreMessageMode(mode) {
  const target = CORE_MODE[mode];
  if (!target) return;
  try {
    if (game.settings.get("core", "messageMode") !== target) {
      game.settings.set("core", "messageMode", target);
    }
  } catch (_) { /* settings not ready — harmless */ }
}

/* The v14 chat input is a <prose-mirror>, so the message reaches the
   chatMessage hook as serialized HTML (e.g. "<p>/roll 3d6</p>") — NOT raw text.
   A naive `message.startsWith("/")` therefore misses slash commands, which is
   why dice codes failed from IC mode (the hook treated the roll as IC text).
   Strip tags first, exactly like Foundry's own ChatLog.parse does. */
function startsWithSlashCommand(message) {
  const tpl = document.createElement("template");
  tpl.innerHTML = String(message ?? "");
  return (tpl.content.textContent ?? "").trim().startsWith("/");
}

/* chatMessage hook — fires inside ChatLog#processMessage BEFORE Foundry
   parses commands. We modify `chatData` directly (the canonical approach)
   rather than juggling textarea-prefix events. */
let _modeHookInstalled = false;
function installModeHook() {
  if (_modeHookInstalled) return;
  _modeHookInstalled = true;

  Hooks.on("chatMessage", (chatLog, message, chatData) => {
    if (!_chatMode || _chatMode === "ooc") return;
    if (startsWithSlashCommand(message)) return;           // user-typed command wins (incl. /roll)

    if (_chatMode === "gm") {
      // Whisper to all GMs — Foundry's downstream ic/ooc handler doesn't
      // touch chatData.whisper, so this override survives.
      chatData.whisper = ChatMessage.getWhisperRecipients("gm").map(u => u.id);
      return;
    }

    if (_chatMode === "ic") {
      // Foundry only assigns IC when command === "ic" (slash) or when
      // command === "none" AND the speaker has a token (auto). To force IC
      // explicitly, build the message ourselves and halt default processing.
      const speaker = chatData.speaker ?? ChatMessage.implementation.getSpeaker();
      if (!speaker?.actor && !speaker?.token) {
        ui.notifications?.warn("Witcher Overhaul UI | Cannot chat IC without a selected token or assigned character.");
        return false;
      }
      const ic = { ...chatData, speaker, content: message.replace(/\n/g, "<br>"), style: CONST.CHAT_MESSAGE_STYLES.IC };
      ChatMessage.implementation.create(ic, { chatBubble: true });
      return false;                                        // halt default processing
    }
  });
}

/* -------------------------------------------------------------------------- */
/*  Input wrap                                                                */
/* -------------------------------------------------------------------------- */

/* Wrap Foundry's bare <textarea#chat-message> in a mockup-style pill with
   a feather icon (left) and a paper-plane send button (right). The send
   button dispatches Enter on the textarea, so it submits via Foundry's
   normal keydown handler. Idempotent + cleans up orphaned wrappers. */
function wrapChatInput() {
  const chatRoot = document.getElementById("chat");
  if (!chatRoot) return;

  const textarea = document.getElementById("chat-message");
  if (!textarea) return;

  // Clean up orphan wrappers — Foundry can re-render the input part without
  // removing the old DOM, leaving multiple .wou-chat-input siblings in the
  // tree. Drop any wrapper that doesn't contain the *current* textarea.
  chatRoot.querySelectorAll(".wou-chat-input").forEach(w => {
    if (!w.contains(textarea)) w.remove();
  });

  // If the current textarea is already inside a wrapper, nothing to do.
  if (textarea.parentElement?.classList?.contains("wou-chat-input")) return;

  const wrapper = document.createElement("div");
  wrapper.className = "wou-chat-input";

  const feather = document.createElement("i");
  feather.className = "fa-solid fa-feather wou-chat-feather";
  feather.setAttribute("aria-hidden", "true");

  const send = document.createElement("button");
  send.type = "button";
  send.className = "wou-chat-send";
  send.setAttribute("aria-label", "Send");
  send.innerHTML = '<i class="fa-solid fa-paper-plane" aria-hidden="true"></i>';
  send.addEventListener("click", (e) => {
    e.preventDefault();
    if (!textarea.value.trim()) return;
    textarea.focus();
    // Foundry's chat handler listens for keydown Enter (without shift). Dispatch one.
    const event = new KeyboardEvent("keydown", {
      key: "Enter", code: "Enter", keyCode: 13, which: 13,
      bubbles: true, cancelable: true
    });
    textarea.dispatchEvent(event);
  });

  // Insert wrapper at the textarea's current position, then move the
  // textarea inside it between feather and send.
  textarea.parentElement.insertBefore(wrapper, textarea);
  wrapper.appendChild(feather);
  wrapper.appendChild(textarea);
  wrapper.appendChild(send);
}

/* Tag each rendered .chat-message with `data-wou-type` (for subnav filtering)
   and `data-wou-recipient` (for colored backdrops on whispered messages).
   Foundry's CONST.CHAT_MESSAGE_STYLES:  OOC=1, IC=2, EMOTE=3, WHISPER=4. */
function tagMessage(el, msg) {
  if (!el || !msg) return;
  const whispers = msg.whisper ?? [];
  const isRoll = (msg.rolls?.length ?? 0) > 0;
  const isWhisper = whispers.length > 0;
  const isBlind = msg.blind === true;
  const style = msg.style;
  const authorId = msg.author?.id ?? msg.user?.id;
  const myId = game.user?.id;
  const isSelf = isWhisper && whispers.length === 1 && whispers[0] === myId && authorId === myId;
  const isToGM = isWhisper && whispers.some(uid => game.users?.get?.(uid)?.isGM);

  // subnav filter type
  let type = "other";
  if (isRoll) type = "rolls";
  else if (isWhisper) type = "whispers";
  else if (style === 2 /* IC */ || style === 3 /* EMOTE */) type = "ic";
  el.dataset.wouType = type;

  // recipient variant for backdrop styling (priority: blind > self > gm > whisper)
  let recipient = "";
  if (isBlind) recipient = "blind";
  else if (isSelf) recipient = "self";
  else if (isToGM) recipient = "gm";
  else if (isWhisper) recipient = "whisper";
  if (recipient) el.dataset.wouRecipient = recipient;
  else delete el.dataset.wouRecipient;
}

function markMessageTypes() {
  document.querySelectorAll("#chat .chat-message").forEach((el) => {
    const id = el.dataset.messageId;
    const msg = id ? game.messages?.get?.(id) : null;
    if (msg) tagMessage(el, msg);
  });
}

/* -------------------------------------------------------------------------- */
/*  Per-message avatars                                                       */
/* -------------------------------------------------------------------------- */

/** Resolve a portrait image url + fallback initial for a chat message. */
function getAvatarPayload(message) {
  // Try actor portrait first (speaker.actor → world Actor → img)
  const actorId = message?.speaker?.actor;
  if (actorId) {
    const actor = game.actors?.get?.(actorId);
    const img = actor?.img;
    if (img && img !== "icons/svg/mystery-man.svg") return { img, initial: null };
  }
  // Fall back to the speaker alias / user name's initial
  const alias = message?.alias ?? message?.user?.name ?? "?";
  const initial = String(alias).trim().charAt(0).toUpperCase() || "?";
  return { img: null, initial };
}

function decorateMessage(html, message) {
  if (!html) return;
  // Foundry hands us either an HTMLElement or a jQuery-wrapped one depending on version.
  const root = html.jquery ? html[0] : html;
  if (!root || !root.classList?.contains("chat-message")) return;

  // Tag every render (cheap; idempotent assignment).
  tagMessage(root, message);

  // Avatar — only insert once.
  if (root.querySelector(":scope > .sb-ava")) return;
  const { img, initial } = getAvatarPayload(message);
  const ava = document.createElement("div");
  ava.className = "sb-ava tiny wou-msg-ava";
  if (img) {
    ava.innerHTML = `<img src="${escapeAttr(img)}" alt="" />`;
  } else {
    ava.textContent = initial;
  }
  root.insertBefore(ava, root.firstChild);
  root.classList.add("wou-has-ava");
}

function escapeAttr(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/* -------------------------------------------------------------------------- */
/*  Public setup                                                              */
/* -------------------------------------------------------------------------- */

let _wired = false;
export function setupChatEnhancements() {
  if (_wired) return;
  _wired = true;

  // Header + input-wrap + mode buttons get re-applied whenever the chat tab
  // re-renders. ApplicationV2's ChatLog fires render hooks; we also try a
  // one-shot now in case the tab already exists at ready time.
  installFilterListener();                                    /* one-time document-level click handler */
  installModeHook();                                          /* one-time chatMessage hook for mode-based whisper/IC */
  const tryDecorate = () => { injectChatHeader(); wrapChatInput(); injectChatModeButtons(); };
  tryDecorate();
  Hooks.on("renderChatLog",  tryDecorate);
  Hooks.on("renderChatTab",  tryDecorate);
  Hooks.on("changeSidebarTab", (tabName) => { if (tabName === "chat") tryDecorate(); });

  // Foundry re-renders the chat input part on certain events without firing
  // a hook we can pin. Watch the chat tab for DOM mutations and re-wrap if
  // the textarea reappears without our wrapper. Debounced via rAF.
  if ("MutationObserver" in window) {
    let queued = false;
    const reapply = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        tryDecorate();
      });
    };
    const start = () => {
      const chatRoot = document.getElementById("chat");
      if (!chatRoot) return false;
      new MutationObserver(reapply).observe(chatRoot, { childList: true, subtree: true });
      return true;
    };
    if (!start()) {
      // Chat tab not in DOM yet — try again on render hook.
      Hooks.once("renderChatLog", start);
    }
  }

  // Per-message avatars — V13 fires renderChatMessageHTML (HTMLElement).
  // The legacy V12 renderChatMessage (jQuery) hook is deprecated in V13
  // and emits a noisy compatibility warning every time chat renders, so
  // we only listen on the V13 hook now. If/when this system needs to
  // support V12 again, re-add the legacy listener.
  Hooks.on("renderChatMessageHTML", (msg, html /*, data */) => decorateMessage(html, msg));

  // Backfill existing messages (e.g., when the world has chat history already
  // and our hook only catches the next message). Walk every rendered .chat-message.
  document.querySelectorAll("#chat .chat-message").forEach((el) => {
    const id = el.dataset.messageId;
    const msg = id ? game.messages?.get?.(id) : null;
    if (msg) decorateMessage(el, msg);
  });
  // After backfill, re-mark types for the filter to pick them up.
  markMessageTypes();

  console.log(`${MODULE_ID} | chat enhancements wired`);
}
