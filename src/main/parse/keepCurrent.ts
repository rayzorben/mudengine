/**
 * What one block's transition keeps current beyond its own case, read off the
 * tracker's commit point: the party's facts (`keepPartyCurrent`), and the
 * gauges of whatever the room now lists, so a monster that walks in or a new
 * room's listing has its gauge at once (todo 20261018-1314-01).
 */
import type { Block } from '../../shared/blocks';
import type { CharacterState } from '../../shared/character';
import type { FightTracker } from './combat';
import { keepPartyCurrent } from './partyUpkeep';

export function keepCurrent(
  before: CharacterState,
  after: CharacterState,
  block: Block,
  moved: boolean,
  fight: Pick<FightTracker, 'rejudge'>
): CharacterState {
  const party = keepPartyCurrent(before, after, block, moved);
  return party.room.occupants === before.room.occupants ? party : fight.rejudge(party, block.at);
}
