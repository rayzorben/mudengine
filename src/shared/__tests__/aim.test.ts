import { describe, expect, it } from 'vitest';

import { attackAim, castAimedAt, occupantNamed } from '../aim';
import { EMPTY_CHARACTER, type RoomOccupant } from '../character';
import type { WorldSpell } from '../world';

/*
 * What a command aims at (todo 816): the reading the tracker's engagement
 * queue and auto-combat share. The server's dispatch: the table first, then
 * the character's spells by short word (`Player.cs:1853-1864`), and `c` casts
 * by the word after it (`CastCommand.cs:80-90`).
 */
const realm = (word: string): WorldSpell | null =>
  (
    ({
      harm: { id: 1, name: 'harm' },
      mihe: { id: 2, name: 'minor healing', short: 'mihe' },
      'minor healing': { id: 2, name: 'minor healing', short: 'mihe' }
    }) as Record<string, WorldSpell>
  )[word] ?? null;

const occupant = (name: string, kind: RoomOccupant['kind']): RoomOccupant =>
  ({ name, kind }) as RoomOccupant;

const here = (...occupants: RoomOccupant[]) => ({
  room: { ...EMPTY_CHARACTER.room, occupants },
  spellbook: null
});

describe('what a command casts at', () => {
  it('reads both spellings of a cast', () => {
    expect(castAimedAt('c mihe soul', null, realm)).toEqual({ word: 'mihe', aimed: 'soul' });
    expect(castAimedAt('harm tall kobold', null, realm)).toEqual({
      word: 'harm',
      aimed: 'tall kobold'
    });
    expect(castAimedAt('c gbls', null, realm)).toEqual({ word: 'gbls', aimed: '' });
  });

  it('never reads a word the table claims as a spell', () => {
    expect(castAimedAt('a tall kobold', null, () => ({ id: 9, name: 'a' }))).toBeNull();
  });

  /* The book is the character's own word on what it can cast; the realm
     answers only while the book is unread. */
  it('asks the book first, and the realm only without one', () => {
    const book = [{ name: 'minor healing', short: 'mihe', level: 1, cost: 2 }];
    expect(castAimedAt('harm rat', book, realm)).toBeNull();
    expect(castAimedAt('mihe rat', book, realm)?.aimed).toBe('rat');
    expect(castAimedAt('dive pool', null, realm)).toBeNull();
  });
});

describe('what an outbound command owes an engagement', () => {
  const thief = occupant('tall kobold thief', 'mob');
  const soul = occupant('Soul', 'player');

  it('owes an attack verb its argument, and a bare one nothing named', () => {
    expect(attackAim('a tall kobold thief', here(thief), realm)).toBe('tall kobold thief');
    expect(attackAim('a', here(thief), realm)).toBeNull();
  });

  it('owes a cast at a listed monster its aim', () => {
    expect(attackAim('harm k', here(thief), realm)).toBe('k');
  });

  it('owes nothing for a cast at a player, at nothing, or at something unlisted', () => {
    expect(attackAim('mihe soul', here(thief, soul), realm)).toBeUndefined();
    expect(attackAim('c gbls', here(thief), realm)).toBeUndefined();
    expect(attackAim('harm dragon', here(thief), realm)).toBeUndefined();
    expect(attackAim('look thief', here(thief), realm)).toBeUndefined();
  });
});

describe('the occupant a typed argument reaches', () => {
  it('takes an exact name over a longer one it also reaches', () => {
    const occupants = [occupant('giant rat', 'mob'), occupant('rat', 'mob')];
    expect(occupantNamed(occupants, 'rat')).toBe('rat');
  });

  it('refuses an argument two monsters answer to', () => {
    const occupants = [occupant('giant rat', 'mob'), occupant('sewer rat', 'mob')];
    expect(occupantNamed(occupants, 'rat')).toBeNull();
  });
});
