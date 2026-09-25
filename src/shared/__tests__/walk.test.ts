import { describe, expect, it } from 'vitest';

import { EMPTY_CHARACTER, NO_AFFLICTIONS } from '../character';
import { DEFAULT_CONFIG } from '../config';
import {
  afflictionHolding,
  isAfflictionHold,
  portalLeftUnseen,
  stillFled,
  type FledRoom
} from '../walk';

/*
 * The rooms an escape must not run back into, and *when* that list forgets.
 *
 * The escape ladder's `forbidden` set is what stops a character running out of
 * a lair and straight back into it. The list used to be emptied by the first
 * instant the client saw no fight, which is an instant a fight against two
 * monsters manufactures for free — `*Combat Off*` names the death of the
 * current target, and the dead leave the attacker list with the kill. Four
 * reproductions, three areas, four deaths (todo 12). The clock is the second
 * test, and this is it.
 */
describe('the rooms still too recently fled to go back into', () => {
  const fled = (room: string, at: number): FledRoom => ({ room, at });

  it('keeps a room fled inside the window', () => {
    const kept = stillFled([fled('1/3', 1_000)], 5_000, 10_000);
    expect(kept.map((entry) => entry.room)).toEqual(['1/3']);
  });

  it('forgets a room fled longer ago than the window', () => {
    expect(stillFled([fled('1/3', 1_000)], 12_000, 10_000)).toEqual([]);
  });

  /*
   * The boundary is exclusive on purpose: at exactly the window the fight that
   * was fled is as old as the client is willing to believe it could be, and
   * the room is a way out again. Stated because *forbidden for ten seconds*
   * and *forbidden for ten seconds inclusive* differ by one status line.
   */
  it('forgets a room fled exactly the window ago', () => {
    expect(stillFled([fled('1/3', 1_000)], 11_000, 10_000)).toEqual([]);
  });

  /*
   * The case the bug was: two rooms fled in one chain of escapes, and the
   * quiet tick between one monster dying and the next swinging. Both are
   * fresh, so neither is a way out — A→B→C and back into A is the same
   * mistake one link longer.
   */
  it('keeps every room of a chain of escapes while all are fresh', () => {
    const kept = stillFled([fled('1/3', 1_000), fled('1/2', 3_000)], 4_000, 10_000);
    expect(kept.map((entry) => entry.room)).toEqual(['1/3', '1/2']);
  });

  /* And forgets only the ones that have aged out, newest kept. */
  it('forgets the older room and keeps the newer', () => {
    const kept = stillFled([fled('1/3', 1_000), fled('1/2', 9_000)], 12_000, 10_000);
    expect(kept.map((entry) => entry.room)).toEqual(['1/2']);
  });

  it('is a filter, not a mutation', () => {
    const rooms = [fled('1/3', 1_000)];
    stillFled(rooms, 99_000, 10_000);
    expect(rooms).toHaveLength(1);
  });
});

/*
 * The one predicate the walker and the loop both ask. Confusion joined it in
 * todo 809 as MegaMUD's `IgnoreConfusion`, whose default waits.
 */
describe('which stated condition stands a walk still', () => {
  const movement = DEFAULT_CONFIG.automation.movement;

  it('waits confusion out by default', () => {
    expect(afflictionHolding({ ...NO_AFFLICTIONS, confused: 'yes' }, movement)).toBe('confused');
  });

  it('walks on confused when the switch says so', () => {
    expect(
      afflictionHolding(
        { ...NO_AFFLICTIONS, confused: 'yes' },
        { ...movement, walkWhileConfused: true }
      )
    ).toBeNull();
  });

  it('does not hold on a confusion nobody has stated', () => {
    expect(afflictionHolding(NO_AFFLICTIONS, movement)).toBeNull();
    expect(afflictionHolding({ ...NO_AFFLICTIONS, confused: 'no' }, movement)).toBeNull();
  });

  it('still holds for a held character, whatever the switches say', () => {
    expect(
      afflictionHolding(
        { ...NO_AFFLICTIONS, held: 'yes', confused: 'yes' },
        { ...movement, walkWhileConfused: true }
      )
    ).toBe('held');
  });

  it('counts confusion among the holds a card names as a condition', () => {
    expect(isAfflictionHold('confused')).toBe(true);
    expect(isAfflictionHold('health')).toBe(false);
    expect(isAfflictionHold(null)).toBe(false);
  });
});

/* A portal left unseen is not nudged: a dark or blind reprint names nothing (todo 808). */
describe('portalLeftUnseen', () => {
  const lit = { ...EMPTY_CHARACTER, room: { ...EMPTY_CHARACTER.room, light: null } };
  const portal = { direction: 'portal' as const };

  it('is a portal step from a blinding room or a blind character', () => {
    expect(portalLeftUnseen(portal, { ...lit, room: { ...lit.room, light: 'pitch black' } })).toBe(
      true
    );
    expect(
      portalLeftUnseen(portal, { ...lit, afflictions: { ...lit.afflictions, blind: 'yes' } })
    ).toBe(true);
  });

  it('is not a lit room, an ordinary step, or a state nobody has', () => {
    expect(portalLeftUnseen(portal, lit)).toBe(false);
    expect(
      portalLeftUnseen({ direction: 'n' }, { ...lit, room: { ...lit.room, light: 'pitch black' } })
    ).toBe(false);
    expect(portalLeftUnseen(portal, undefined)).toBe(false);
  });
});
