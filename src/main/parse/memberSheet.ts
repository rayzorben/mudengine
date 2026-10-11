/**
 * A party member's own stat sheet, as their client answered `@stats` (todo
 * 86): Strength, level, Traps and Picklocks on their row, which is what the
 * leader reads to send the member with the best odds at a trap or a door.
 * Only a member's row: a stranger's sheet decides nothing here. Nothing else
 * on this server says another character's figures. `mudengine-automation` ›
 * parts/remotes.md.
 */
import type { CharacterState } from '../../shared/character';
import { parseRemoteReply } from '../../shared/remotes';

/** The state with `who`'s sheet on their row, or null when the line is no sheet or no member's. */
export function withMemberSheet(
  s: CharacterState,
  who: string | undefined,
  message: string | undefined
): CharacterState | null {
  if (who === undefined || message === undefined) return null;
  const reply = parseRemoteReply(message);
  if (reply?.kind !== 'stats') return null;
  const index = s.party.members.findIndex((held) => held.name.toLowerCase() === who.toLowerCase());
  if (index === -1) return null;
  const members = s.party.members.map((held, at) =>
    at === index ? { ...held, sheet: reply.sheet } : held
  );
  return { ...s, party: { ...s.party, members } };
}
