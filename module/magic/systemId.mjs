/**
 * The system's own id, declared once.
 *
 * This engine was written against the upstream system it forked from, and
 * three files each carried `const SYSTEM_ID = "TheWitcherTRPG"` — the OLD id.
 * This system's id is `witcher-ttrpg-death-march`.
 *
 * That single wrong string broke roughly thirty flag operations. Foundry
 * validates a flag scope against the installed packages and THROWS on a
 * miss — `Flag scope "TheWitcherTRPG" is not valid or not currently active` —
 * so every `setFlag`/`getFlag` in the engine raised. Chaos tracking, Quen's
 * shield, concentration, counteract, the daylight probes, and the cast card's
 * own `castVerdict` flag all died the moment they were touched.
 *
 * The card was the visible half: `flags[SYSTEM_ID]` wrote the verdict under a
 * scope nothing else reads, so a spell resolved, posted a card, and offered no
 * damage button and no per-target block. From the table it looked exactly like
 * "the blocks did not run".
 *
 * Nothing caught it because every test in this engine runs against a stub
 * `getFlag` that accepts any scope. Real Foundry does not. Hence the pinning
 * test in `systemId.test.mjs`, which reads the id out of system.json rather
 * than trusting this file, and fails if any file under magic/ ever hardcodes
 * a system id again.
 */
export const SYSTEM_ID = "witcher-ttrpg-death-march";
