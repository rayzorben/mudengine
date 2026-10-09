import { describe, expect, it } from 'vitest';

import { UnlistedSearcher } from '../UnlistedSearcher';
import { domainOf, type Block } from '../../../shared/blocks';
import { EMPTY_CHARACTER, type CharacterState, type RoomOccupant } from '../../../shared/character';
import { REREAD_ROOM } from '../../../shared/commands';
import type { Intent } from '../CommandQueue';

const searches = (player: string): Block => ({
  seq: 1,
  at: 1_700_000_000_000,
  type: 'player-searches',
  domain: domainOf('player-searches'),
  groups: { player },
  text: `${player} is searching the area.`,
  terminator: 'newline',
  confidence: 0.8
});

const here = (names: string[], arrival = 1): CharacterState => ({
  ...structuredClone(EMPTY_CHARACTER),
  phase: 'in-game',
  room: {
    ...structuredClone(EMPTY_CHARACTER.room),
    arrival,
    occupants: names.map((name): RoomOccupant => ({
      name,
      kind: 'player',
      disposition: null,
      uncertain: false,
      costly: 'never',
      charmed: false,
      hidden: false,
      free: false
    }))
  }
});

function searcher(): { module: UnlistedSearcher; sent: Intent[] } {
  const sent: Intent[] = [];
  const module = new UnlistedSearcher({ enqueue: (intent) => sent.push(intent) > 0 });
  return { module, sent };
}

describe('a player searching a room that did not list them', () => {
  it('reprints the room once with a bare Enter', () => {
    const { module, sent } = searcher();
    module.onCharacter(here(['Soul']));
    module.onBlock(searches('Qzyphus'));
    module.onBlock(searches('Qzyphus'));
    expect(sent.map((intent) => intent.command)).toEqual([REREAD_ROOM]);
    expect(sent[0]?.priority).toBe('probe');
  });

  it('leaves a listed searcher alone, whatever the case', () => {
    const { module, sent } = searcher();
    module.onCharacter(here(['qzyphus']));
    module.onBlock(searches('Qzyphus'));
    expect(sent).toEqual([]);
  });

  it('asks again in the next room', () => {
    const { module, sent } = searcher();
    module.onCharacter(here([], 1));
    module.onBlock(searches('Qzyphus'));
    module.onCharacter(here([], 2));
    module.onBlock(searches('Qzyphus'));
    expect(sent).toHaveLength(2);
  });

  it('asks nothing before a room is known', () => {
    const { module, sent } = searcher();
    module.onBlock(searches('Qzyphus'));
    expect(sent).toEqual([]);
  });
});

describe('the Enter asked for a searcher', () => {
  it('is no longer wanted once the character has moved on', () => {
    const { module, sent } = searcher();
    module.onCharacter(here([], 1));
    module.onBlock(searches('Qzyphus'));
    expect(sent[0]?.stillWanted?.()).toBe(true);
    module.onCharacter(here([], 2));
    expect(sent[0]?.stillWanted?.()).toBe(false);
  });
});
