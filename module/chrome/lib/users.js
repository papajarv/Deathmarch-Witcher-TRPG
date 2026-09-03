/**
 * Pure data helpers for the Party section.
 * No DOM. No side effects. Safe to call from anywhere once Foundry is ready.
 */

/**
 * Fetch all users with their assigned characters and online status.
 *
 * @returns {Array<{user: User, character: Actor|null, online: boolean, isSelf: boolean, isGM: boolean}>}
 *          Sorted GM-first, then alphabetical by user name.
 */
export function getRoster() {
  const selfId = game.user.id;
  const rows = game.users.contents.map(user => ({
    user,
    character: user.character ?? null,
    online: !!user.active,
    isSelf: user.id === selfId,
    isGM: user.isGM
  }));
  rows.sort((a, b) => {
    if (a.isGM !== b.isGM) return a.isGM ? -1 : 1;
    return a.user.name.localeCompare(b.user.name);
  });
  return rows;
}

/**
 * Fetch all character-type actors available for assignment.
 *
 * @returns {Array<Actor>} Character-type actors only, sorted alphabetical by name.
 */
export function getAssignableActors() {
  return game.actors.contents
    .filter(a => a.type === "character")
    .sort((a, b) => a.name.localeCompare(b.name));
}
