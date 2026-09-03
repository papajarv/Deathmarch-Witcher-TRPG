/**
 * Book system mechanic — the 3-type book mechanic (monster lore, skill,
 * stress) from witcher-overhaul-ui. Homebrew (ADR 0003), opt-in via
 * `isHomebrewEnabled("bookSystem")`.
 *
 * Data shape lives in `valuable.system.bookConfig` (set on the book item)
 * and `character.system.bookUsage[encKey(uuid)]` (per-character read state).
 *
 * This file owns the *logic*. The sheet integration (a "Study" button on
 * a book valuable, the stress-counter tick from a stress book) lands in
 * the corresponding sheet code as part of Phase 4b follow-up.
 *
 * Phase 7: skeleton + the most important entry point (`readBook`).
 * Full per-book-type behavior (knowledge milestones, daily-limit cooldown,
 * stress steps) ports incrementally.
 */

import { isHomebrewEnabled } from "../api/homebrew.mjs";

import { t, tFormat } from "../chrome/lib/i18n.js";
/**
 * Stable encoding of an item uuid for use as a flat object key on
 * `character.system.bookUsage`. Periods and slashes confuse Foundry's
 * update merger, so we base64-ish them away.
 */
export function encKey(uuid) {
    return uuid.replace(/[./]/g, "_");
}

/**
 * Top-level: a character reads a book. The book is a valuable item with
 * `system.bookConfig.bookType`.
 *
 * No-op (with a notification) when the homebrew toggle is off so users
 * who disable the book system don't accidentally tick state.
 */
export async function readBook(character, bookItem) {
    if (!isHomebrewEnabled("bookSystem")) {
        ui.notifications?.info(t("WITCHER.Mech.BookSystem.Notify.BookSystemIsDisabledHomebrewOff", "Book system is disabled (homebrew off)."));
        return;
    }
    if (!character || !bookItem) return;
    const cfg = bookItem.system?.bookConfig;
    if (!cfg) return ui.notifications?.warn(tFormat("WITCHER.Mech.BookSystem.Notify.NoBookConfigurationOnX", { bookItem: bookItem.name }, "No book configuration on {bookItem}."));

    switch (cfg.bookType) {
        case "monster": return readMonsterBook(character, bookItem, cfg.monster);
        case "skill":   return readSkillBook(character, bookItem, cfg.skill);
        case "stress":  return readStressBook(character, bookItem, cfg.stress);
        default:
            return ui.notifications?.warn(tFormat("WITCHER.Mech.BookSystem.Notify.UnknownBookType", { bookType: cfg.bookType, bookItem: bookItem.name }, "Unknown bookType '{bookType}' on {bookItem}."));
    }
}

/**
 * Get / create the per-book usage record on a character.
 */
function getUsage(character, bookItem) {
    const key = encKey(bookItem.uuid);
    return character.system.bookUsage?.[key] ?? {
        lastAttemptDay: 0,
        hits:           0,
        readingCount:   0,
        currentStep:    0,
        completed:      false,
        /* worldTime (seconds) of the last successful stress-book step.
         * Enforces STRESS_STEP_COOLDOWN_S between chapter reads so a novel
         * can't be blitzed in a single sitting. Legacy usage records may
         * lack this field — treated as 0 (i.e. no cooldown active). */
        lastReadTime:   0
    };
}

/* In-world seconds between two successive stress-book (novel/lore) steps.
 * 4 hours — a chapter takes time to absorb. */
const STRESS_STEP_COOLDOWN_S = 4 * 3600;

async function writeUsage(character, bookItem, usage) {
    const key = encKey(bookItem.uuid);
    return character.update({
        [`system.bookUsage.${key}`]: usage
    });
}

/* -------------------------------------------------------------------------- */
/* Monster-lore book                                                          */
/* -------------------------------------------------------------------------- */

async function readMonsterBook(character, bookItem, monsterCfg) {
    const usage = getUsage(character, bookItem);
    if (usage.completed) {
        return ui.notifications?.info(tFormat("WITCHER.Mech.BookSystem.Notify.XHasAlreadyFinishedX", { character: character.name, bookItem: bookItem.name }, "{character} has already finished {bookItem}."));
    }
    const today = Math.floor(game.time.worldTime / 86400);
    if (usage.lastAttemptDay === today) {
        return ui.notifications?.info(t("WITCHER.Mech.BookSystem.Notify.AlreadyStudiedToday", "Already studied today."));
    }

    // Roll vs monsterCfg.dc (default 12). Full extendedRoll flow lands
    // here in Phase 7 follow-up; for now we count this as a hit on
    // success and advance the reading counter.
    const dc = monsterCfg?.dc ?? 12;
    const v  = character._readSkillValues?.("education") ?? null;
    const passed = v ? (10 + v.statVal + v.skillVal) >= dc : true;  // best-guess until full roll lands

    if (passed) usage.hits += 1;
    usage.readingCount += 1;
    usage.lastAttemptDay = today;
    if (monsterCfg?.totalReadings && usage.readingCount >= monsterCfg.totalReadings) {
        usage.completed = true;
        // Phase 7 follow-up: grant the knowledge milestones at the
        // configured reading numbers (academicKnowledgeReading,
        // witcherKnowledgeReading) — see project_book_system memory.
    }
    await writeUsage(character, bookItem, usage);
    return usage;
}

/* -------------------------------------------------------------------------- */
/* Skill book                                                                 */
/* -------------------------------------------------------------------------- */

async function readSkillBook(character, bookItem, skillCfg) {
    if (!skillCfg?.skillId) return ui.notifications?.warn(tFormat("WITCHER.Mech.BookSystem.Notify.SkillBookXHasNoSkill", { bookItem: bookItem.name }, "Skill book {bookItem} has no skill configured."));
    const stat  = skillCfg.skillStat;
    const skill = skillCfg.skillId;
    const cur = character.system.skills?.[stat]?.[skill];
    if (!cur) return ui.notifications?.warn(tFormat("WITCHER.Mech.BookSystem.Notify.CharacterHasNoSkillXX", { stat: stat, skill: skill }, "Character has no skill {stat}.{skill}."));

    const rank = cur.value + (cur.modifier ?? 0);
    if (skillCfg.rangeMin != null && rank < skillCfg.rangeMin) {
        return ui.notifications?.warn(tFormat("WITCHER.Mech.BookSystem.Notify.RankBelowMin", { rank, min: skillCfg.rangeMin }, "Skill rank {rank} is below the book's minimum ({min})."));
    }
    if (skillCfg.rangeMax != null && rank >= skillCfg.rangeMax) {
        return ui.notifications?.info(tFormat("WITCHER.Mech.BookSystem.Notify.RankAboveCap", { max: skillCfg.rangeMax }, "Skill rank already at or above this book's cap ({max})."));
    }

    // Advance the skill by 1 (write to base value, not modifier).
    await character.update({
        [`system.skills.${stat}.${skill}.value`]: cur.value + 1
    });
}

/* -------------------------------------------------------------------------- */
/* Stress book                                                                */
/* -------------------------------------------------------------------------- */

async function readStressBook(character, bookItem, stressCfg) {
    if (!isHomebrewEnabled("stress")) {
        return ui.notifications?.info(t("WITCHER.Mech.BookSystem.Notify.StressMechanicIsDisabled", "Stress mechanic is disabled."));
    }
    const usage = getUsage(character, bookItem);
    const steps = stressCfg?.steps ?? [];
    if (usage.currentStep >= steps.length) {
        return ui.notifications?.info(tFormat("WITCHER.Mech.BookSystem.Notify.XHasFinishedX", { character: character.name, bookItem: bookItem.name }, "{character} has finished {bookItem}."));
    }
    /* 4h step cooldown. Reader can't blitz every chapter of a novel in one
     * sitting — each step needs in-world time to sink in. Skipped for the
     * very first read (lastReadTime === 0). */
    const now  = game.time?.worldTime ?? 0;
    const last = Number(usage.lastReadTime) || 0;
    if (last > 0 && (now - last) < STRESS_STEP_COOLDOWN_S) {
        const remain  = STRESS_STEP_COOLDOWN_S - (now - last);
        const hrs     = Math.floor(remain / 3600);
        const mins    = Math.ceil((remain % 3600) / 60);
        const wait    = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;
        return ui.notifications?.info(tFormat(
            "WITCHER.Mech.BookSystem.Notify.NeedRestBeforeNextChapter",
            { character: character.name, bookItem: bookItem.name, wait },
            "{character} needs {wait} before reading the next chapter of {bookItem}."
        ));
    }
    const step = steps[usage.currentStep];
    const newStress = Math.max(0, (character.system.stress ?? 0) + (step.stressChange ?? 0));

    await character.update({ "system.stress": newStress });
    usage.currentStep += 1;
    usage.lastReadTime = now;
    if (usage.currentStep >= steps.length) usage.completed = true;
    await writeUsage(character, bookItem, usage);

    if (step.text) {
        ChatMessage.create({
            speaker: ChatMessage.getSpeaker({ actor: character }),
            content: tFormat("WITCHER.Mech.BookSystem.Chat.Step", { book: bookItem.name, text: step.text }, "<h3>{book}</h3><div>{text}</div>")
        });
    }
}
