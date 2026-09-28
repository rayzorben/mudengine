/**
 * The party's volunteered facts kept current across one block, read off the
 * transition from the tracker's commit point rather than from each case: a
 * member's fight ends with its monster (`fightsStillHere`), and a member seen
 * acting is no longer resting (`upFromRest`). `mudengine-wire` ›
 * `parts/character.md` › *The party roster*.
 */
import type { Block } from '../../shared/blocks';
import type { CharacterState } from '../../shared/character';
import { fightsStillHere } from './engagements';
import { upFromRest } from './presence';

export function keepPartyCurrent(
  before: CharacterState,
  after: CharacterState,
  block: Block,
  moved: boolean
): CharacterState {
  const fights =
    !moved && after.room.occupants === before.room.occupants
      ? after
      : fightsStillHere(before, after, moved);
  const acting = actors(before, after, block);
  return acting.length === 0 ? fights : upFromRest(fights, acting);
}

/** Who this block showed doing something that stands a player up. */
function actors(before: CharacterState, after: CharacterState, block: Block): string[] {
  const seen = [
    ...changed(before.party.engaged, after.party.engaged),
    ...changed(before.party.threatened, after.party.threatened)
  ];
  const named =
    block.type === 'player-leaves-room'
      ? block.groups['player']
      : block.type === 'spell-cast'
        ? block.groups['caster']
        : undefined;
  return named === undefined ? seen : [...seen, named];
}

/** The keys whose entry this block wrote. */
function changed<T>(was: Record<string, T>, now: Record<string, T>): string[] {
  if (was === now) return [];
  return Object.keys(now).filter((name) => now[name] !== was[name]);
}
