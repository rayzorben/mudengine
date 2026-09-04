import { describe, expect, it } from 'vitest';

import { knownGangs, membersOf } from '../gangs';
import { EMPTY_CHARACTER, type Adventurer, type CharacterState } from '@shared/character';
import { playerKey, type PlayerRecord } from '@shared/players';

const NOW = 1_700_000_000_000;

/** A registry record: what a listing or a look established about somebody. */
function record(over: Partial<PlayerRecord> & { name: string }): PlayerRecord {
  return {
    alignment: null,
    title: null,
    flags: null,
    gang: null,
    level: null,
    race: null,
    className: null,
    gangRank: null,
    equipment: null,
    equipmentAt: null,
    lastRoom: null,
    lastRoomName: null,
    lastRoomAt: null,
    lastSeen: NOW,
    online: false,
    vitals: null,
    vitalsAt: null,
    inParty: false,
    commandsSent: 0,
    lastCommand: null,
    lastCommandAt: null,
    ...over
  };
}

/** A `who` row: who is logged in, and almost nothing else. */
function adventurer(over: Partial<Adventurer> & { name: string }): Adventurer {
  return {
    alignment: null,
    title: null,
    flags: null,
    gang: null,
    provisional: false,
    ...over
  } as Adventurer;
}

function character(over: Partial<CharacterState> = {}): CharacterState {
  return { ...EMPTY_CHARACTER, ...over };
}

/*
 * The assembly lived inside `GangCard` and could only ever be asked about this
 * character's own gang. A gang printed in a `who` listing is a thing somebody
 * points at, so it takes the gang as an argument now — and both surfaces read
 * the same function, which is what stops the card and the panel disagreeing
 * about who is in a gang.
 */
describe('who is known to be in a gang', () => {
  it('takes the members a listing established', () => {
    const state = character({
      players: {
        [playerKey('Rend')]: record({ name: 'Rend', gang: 'Valor', level: 12, gangRank: 'Leader' })
      }
    });
    expect(membersOf(state, 'Valor').map((row) => [row.name, row.level, row.rank])).toEqual([
      ['Rend', 12, 'Leader']
    ]);
  });

  /* The registry is the only source that can say somebody is *not* logged in;
     the roster is the fresher of the two about presence. */
  it('lets the roster correct a stale offline flag', () => {
    const state = character({
      players: { [playerKey('Rend')]: record({ name: 'Rend', gang: 'Valor', level: 12 }) },
      online: [adventurer({ name: 'Rend', gang: 'Valor' })]
    });
    const [row] = membersOf(state, 'Valor');
    expect(row?.online).toBe(true);
    // And everything the listing established is kept.
    expect(row?.level).toBe(12);
  });

  /* Useful before any button is pressed rather than empty until one is. */
  it('falls back to the roster for somebody no listing has covered', () => {
    const state = character({ online: [adventurer({ name: 'Soul', gang: 'Valor' })] });
    const [row] = membersOf(state, 'Valor');
    expect(row).toMatchObject({ name: 'Soul', online: true, rosterOnly: true, level: null });
  });

  /* A gang name is typed by whoever founded it and the server is inconsistent
     about case. */
  it('matches the gang case-insensitively', () => {
    const state = character({ online: [adventurer({ name: 'Soul', gang: 'valor' })] });
    expect(membersOf(state, 'VALOR')).toHaveLength(1);
  });

  it('says nothing about a gang nothing has named', () => {
    const state = character({ online: [adventurer({ name: 'Soul', gang: 'Valor' })] });
    expect(membersOf(state, 'Rhudaur')).toEqual([]);
  });

  /*
   * `trackPlayers` files everybody *except* self, so this character's own row
   * exists only on the roster — and not at all while offline. A gang of two
   * that draws one member is the card contradicting the listing above it.
   */
  it('includes this character in its own gang', () => {
    const state = character({
      name: 'Vaelor',
      phase: 'in-game',
      online: [adventurer({ name: 'Vaelor', gang: 'Valor' })],
      players: { [playerKey('Rend')]: record({ name: 'Rend', gang: 'Valor' }) }
    });
    const rows = membersOf(state, 'Valor');
    expect(rows.map((row) => row.name).sort()).toEqual(['Rend', 'Vaelor']);
    expect(rows.find((row) => row.name === 'Vaelor')?.self).toBe(true);
  });

  /*
   * And never into somebody else's. Adding this character's row to a gang it is
   * not in would be the client asserting a membership nothing said.
   */
  it('does not add this character to a gang that is not its own', () => {
    const state = character({
      name: 'Vaelor',
      phase: 'in-game',
      online: [
        adventurer({ name: 'Vaelor', gang: 'Valor' }),
        adventurer({ name: 'Rend', gang: 'Rhudaur' })
      ]
    });
    expect(membersOf(state, 'Rhudaur').map((row) => row.name)).toEqual(['Rend']);
  });

  /* Who is on is the question a gang is looked up for, so they lead. */
  it('puts the online members first, then sorts by name', () => {
    const state = character({
      players: {
        [playerKey('Zed')]: record({ name: 'Zed', gang: 'Valor', online: true }),
        [playerKey('Abe')]: record({ name: 'Abe', gang: 'Valor', online: false }),
        [playerKey('Mia')]: record({ name: 'Mia', gang: 'Valor', online: true })
      }
    });
    expect(membersOf(state, 'Valor').map((row) => row.name)).toEqual(['Mia', 'Zed', 'Abe']);
  });

  it('answers nothing for a blank gang', () => {
    const state = character({ online: [adventurer({ name: 'Soul', gang: 'Valor' })] });
    expect(membersOf(state, '   ')).toEqual([]);
  });
});

describe('the gangs a character has heard of', () => {
  it('is the roster and the registry together, by their printed spelling', () => {
    const state = character({
      players: { [playerKey('Rend')]: record({ name: 'Rend', gang: 'Rhudaur' }) },
      online: [adventurer({ name: 'Soul', gang: 'Valor' })]
    });
    expect(knownGangs(state)).toEqual(['Rhudaur', 'Valor']);
  });

  /* One gang, not two links for it, whatever case the two sources used. */
  it('folds two spellings of one gang into the later one', () => {
    const state = character({
      players: { [playerKey('Rend')]: record({ name: 'Rend', gang: 'valor' }) },
      online: [adventurer({ name: 'Soul', gang: 'Valor' })]
    });
    expect(knownGangs(state)).toEqual(['Valor']);
  });

  /* This character's own gang is a gang like any other, and the one printed
     most often. */
  it('includes this character own gang from its roster row', () => {
    const state = character({
      name: 'Vaelor',
      online: [adventurer({ name: 'Vaelor', gang: 'Valor' })]
    });
    expect(knownGangs(state)).toEqual(['Valor']);
  });

  it('is empty when nothing has named one', () => {
    expect(knownGangs(character())).toEqual([]);
  });
});
