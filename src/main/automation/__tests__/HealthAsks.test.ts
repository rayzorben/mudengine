import { describe, expect, it } from 'vitest';

import { HealthAsks } from '../HealthAsks';
import { CONFIG } from '../walk/__tests__/walking';
import type { AutomationConfig } from '../../../shared/config';
import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';
import type { Block } from '../../../shared/blocks';
import { member } from '../../parse/presence';

/* Todo 142: a member is asked `@health` on a join, and once on first showing in a listing. */
const party = (names: string[], following: string | null = null): CharacterState => {
  const base = structuredClone(EMPTY_CHARACTER);
  return {
    ...base,
    name: 'Festus',
    party: {
      ...base.party,
      following,
      members: [
        member('Festus', { health: 1 }),
        ...names.map((name) => member(name, { health: 1 }))
      ]
    }
  };
};

const header = { type: 'party-roster', groups: {} } as unknown as Block;
const alone = { type: 'party-alone', groups: {} } as unknown as Block;

describe('asking a member for their figures', () => {
  const make = (askHealth = true): { asks: HealthAsks; asked: string[] } => {
    const asked: string[] = [];
    const config: AutomationConfig = { ...CONFIG, party: { ...CONFIG.party, askHealth } };
    const asks = new HealthAsks(config, (who) => {
      asked.push(who);
      return true;
    });
    return { asks, asked };
  };

  /* A listing this character connected into: nobody was seen joining. */
  it('asks a member a listing shows whom nobody asked, once', () => {
    const { asks, asked } = make();
    const before = party([]);
    asks.onBlock(header, before);
    asks.onCharacter(before);
    expect(asked).toEqual([]);
    asks.onCharacter(party(['Brackle']));
    expect(asked).toEqual(['Brackle']);
    asks.onBlock(header, party(['Brackle']));
    asks.onCharacter(party(['Brackle']));
    expect(asked).toEqual(['Brackle']);
  });

  it('asks on every join, and does not ask the joiner again when the listing shows him', () => {
    const { asks, asked } = make();
    asks.joined('Brackle', party(['Brackle']));
    asks.onBlock(header, party(['Brackle']));
    asks.onCharacter(party(['Brackle']));
    expect(asked).toEqual(['Brackle']);
    asks.joined('Brackle', party(['Brackle']));
    expect(asked).toEqual(['Brackle', 'Brackle']);
  });

  it('asks again once a listing has shown a member gone and back', () => {
    const { asks, asked } = make();
    asks.joined('Brackle', party(['Brackle']));
    asks.onBlock(header, party(['Brackle']));
    asks.onCharacter(party([]));
    asks.onBlock(header, party([]));
    asks.onCharacter(party(['Brackle']));
    expect(asked).toEqual(['Brackle', 'Brackle']);
  });

  /* The one-row list a lone character gets ends the party as a full list does. */
  it('forgets a member once the party list says this character is alone', () => {
    const { asks, asked } = make();
    asks.joined('Brackle', party(['Brackle']));
    // Control: a list still showing him asks nothing.
    asks.onBlock(header, party([]));
    asks.onCharacter(party(['Brackle']));
    expect(asked).toEqual(['Brackle']);
    asks.onBlock(alone, party(['Brackle']));
    asks.onCharacter(party([]));
    asks.onBlock(header, party([]));
    asks.onCharacter(party(['Brackle']));
    expect(asked).toEqual(['Brackle', 'Brackle']);
  });

  it('keeps the leader it follows, whom a listing may not have shown yet', () => {
    const { asks, asked } = make();
    asks.joined('Rath', party([], 'Rath'));
    asks.onBlock(header, party([], 'Rath'));
    asks.onCharacter(party(['Rath'], 'Rath'));
    expect(asked).toEqual(['Rath']);
  });

  it('asks nobody with Request Party Health off', () => {
    const { asks, asked } = make(false);
    asks.joined('Brackle', party(['Brackle']));
    asks.onBlock(header, party([]));
    asks.onCharacter(party(['Brackle']));
    expect(asked).toEqual([]);
  });
});
