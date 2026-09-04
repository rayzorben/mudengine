/*
 * The import order here is the test.
 *
 * `players` is imported **first**, deliberately, and nothing else may be added
 * above it. That is the order that used to be broken: `character.ts` needed
 * `NO_PLAYERS` to build `EMPTY_CHARACTER` and `players.ts` needed `ALIGNMENTS`
 * to parse a record, two value imports pointing at each other. Entered through
 * `players`, `character` evaluated while `players` was still in flight and
 * captured `NO_PLAYERS` as `undefined` — so `EMPTY_CHARACTER.players` was
 * `undefined` rather than `{}`, permanently, for every consumer in that graph.
 *
 * It went unnoticed for as long as every entry point happened to reach
 * `players` second, and surfaced the moment a new renderer module imported the
 * pair the other way round: `Object.values(undefined)` thrown out of a state
 * constant the whole client treats as safe. `src/shared/alignment.ts` holds the
 * vocabulary both of them share, so neither imports the other's values now.
 *
 * A file of its own because a test file's imports are hoisted in source order,
 * and folding this into `character.test.ts` would let an import added above it
 * later silently establish the safe order and retire the check.
 */
import { NO_PLAYERS } from '../players';
import { describe, expect, it } from 'vitest';

import { EMPTY_CHARACTER, NO_COMBAT, NO_PARTY } from '../character';

describe('the shared state constants, entered through players', () => {
  it('has a registry on the empty character rather than an undefined', () => {
    expect(EMPTY_CHARACTER.players).toEqual({});
    expect(EMPTY_CHARACTER.players).toBe(NO_PLAYERS);
  });

  /*
   * The neighbours, because a cycle breaks whichever constant happens to be
   * built while the other module is in flight — not only the one that was
   * noticed. All of these are `EMPTY_CHARACTER`'s own fields and every one of
   * them is read as an object or an array by somebody.
   */
  it('has every other composite field it declares', () => {
    expect(EMPTY_CHARACTER.combat).toBe(NO_COMBAT);
    expect(EMPTY_CHARACTER.party).toBe(NO_PARTY);
    expect(Array.isArray(EMPTY_CHARACTER.online)).toBe(true);
    expect(Array.isArray(EMPTY_CHARACTER.banks)).toBe(true);
    expect(Array.isArray(EMPTY_CHARACTER.loadout)).toBe(true);
    expect(EMPTY_CHARACTER.room).not.toBeUndefined();
    expect(EMPTY_CHARACTER.vitals).not.toBeUndefined();
    expect(EMPTY_CHARACTER.inventory).not.toBeUndefined();
    expect(EMPTY_CHARACTER.afflictions).not.toBeUndefined();
  });
});
