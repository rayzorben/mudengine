import { describe, expect, it } from 'vitest';

import { countedLabel, countedList, countedName, itemHitProcs, itemInvocation } from '../items';

/*
 * Every listing this server prints counts, and until 2026-09-06 two of the
 * three left the figure glued to the front of the name — which is how a
 * character holding `2 bone key` came to be told the door beside it needed a
 * bone key (todo 01).
 */
describe('the figure in front of a listing entry', () => {
  it('comes off the name and is kept as a count', () => {
    expect(countedName('2 bone key')).toEqual({ count: 2, name: 'bone key' });
    expect(countedName('66 bone key')).toEqual({ count: 66, name: 'bone key' });
    // captures/119, and the reason the split is on the figure rather than on a
    // word: the item is called `rope and grapple`.
    expect(countedName('2 rope and grapple')).toEqual({ count: 2, name: 'rope and grapple' });
  });

  it('leaves an uncounted entry exactly as the listing spelled it', () => {
    expect(countedName('bone key')).toEqual({ count: 1, name: 'bone key' });
    expect(countedName('  katana (Weapon Hand)  ')).toEqual({
      count: 1,
      name: 'katana (Weapon Hand)'
    });
  });

  /*
   * The plural stays on. Only an index can say whether `keys` is this realm's
   * plural of `key` or the last word of the item — `padded gloves` is a real
   * row — so `WorldGraph.itemIdNamed` settles it where the realm can be asked.
   */
  it('does not undo a plural the count brought with it', () => {
    expect(countedName('2 black star keys')).toEqual({ count: 2, name: 'black star keys' });
  });

  /*
   * A figure no listing could have written is not a figure. Callers expand a
   * count into that many instances, and `Array.from({ length: 1e23 })` throws
   * in the middle of the parse path.
   */
  it('refuses a figure no listing could have written', () => {
    expect(countedName('99999999999999999999 x')).toEqual({
      count: 1,
      name: '99999999999999999999 x'
    });
    expect(countedName('0 bone key')).toEqual({ count: 1, name: '0 bone key' });
  });

  it('writes a counted entry back the way the server wrote it', () => {
    expect(countedLabel({ name: 'bone key', count: 66 })).toBe('66 bone key');
    // Absent and one are the same answer, because the server prints neither.
    expect(countedLabel({ name: 'bone key', count: 1 })).toBe('bone key');
    expect(countedLabel({ name: 'bone key' })).toBe('bone key');
  });
});

/*
 * The key ring is held as instances so the realm's row for one can be found;
 * the card reads it back counted, which is the spelling that stays legible
 * when a character is standing on a crypt floor holding sixty-six.
 */
describe('a list of instances read back', () => {
  it('folds repeats into the server’s own counted form', () => {
    expect(countedList(['bone key', 'bone key'])).toEqual(['2 bone key']);
  });

  it('keeps first-appearance order, so the ring does not reshuffle', () => {
    expect(countedList(['silver key', 'bone key', 'bone key', 'silver key'])).toEqual([
      '2 silver key',
      '2 bone key'
    ]);
  });

  it('leaves a ring of one of each alone', () => {
    expect(countedList(['black star key', 'ancient obsidian key'])).toEqual([
      'black star key',
      'ancient obsidian key'
    ]);
    expect(countedList([])).toEqual([]);
  });
});

/*
 * What an item casts when it is used.
 *
 * The pairs here are verbatim out of the shipped realm, because the rule they
 * exercise is the server's own and it is not one anybody would guess: a
 * `CastsSp` preceded by a `PercentSpell` is a chance-on-hit proc, and a bare
 * one is something `use` invokes (`ItemType.cs`, whose own comment calls the
 * logic what it is).
 */
describe('what an item casts when it is used', () => {
  /* `shimmering longsword` — the one that carries both shapes at once. */
  const LONGSWORD = {
    abilities: [
      [28, 1],
      [86, 50],
      [43, 114],
      [114, 40],
      [43, 170],
      [135, 10]
    ] as ReadonlyArray<readonly [number, number]>,
    uses: -1
  };

  it('finds the bless a weapon can be asked for', () => {
    expect(itemInvocation(LONGSWORD)).toEqual({ spell: 114, unlimited: true });
  });

  /*
   * The proc in the same item is *not* offered. `[114, 40]` immediately before
   * `[43, 170]` makes that one a forty-per-cent chance on hit, which no
   * command can trigger — offering it would have the client type `use` at a
   * thing the server does nothing with, once per retry, all evening.
   */
  it('does not offer a chance-on-hit proc', () => {
    const procOnly = {
      abilities: [
        [114, 40],
        [43, 170]
      ] as ReadonlyArray<readonly [number, number]>,
      uses: -1
    };
    expect(itemInvocation(procOnly)).toBeNull();
  });

  /* `carved ivory mask` — three charges, so invoking it is not free. */
  it('says when invoking it costs a charge', () => {
    const mask = {
      abilities: [
        [13, 25],
        [28, 1],
        [43, 917],
        [121, 3],
        [77, 3]
      ] as ReadonlyArray<readonly [number, number]>,
      uses: 3
    };
    expect(itemInvocation(mask)).toEqual({ spell: 917, unlimited: false });
  });

  /*
   * An item the realm says nothing about is not unlimited. Absent used to mean
   * both *nothing said* and *for ever*, which is the conflation format 25
   * exists to end.
   */
  it('does not read silence as unlimited', () => {
    expect(itemInvocation({ abilities: [[43, 114]] })).toEqual({ spell: 114, unlimited: false });
  });

  it('says nothing about an item that casts nothing', () => {
    expect(itemInvocation({ abilities: [[28, 1]], uses: -1 })).toBeNull();
    expect(itemInvocation({})).toBeNull();
  });

  /* Slot zero is the realm's empty cell, not a spell. */
  it('refuses a spell of zero', () => {
    expect(itemInvocation({ abilities: [[43, 0]], uses: -1 })).toBeNull();
  });
});

/**
 * The other half of the same pair — and the only thing on the client that can
 * attribute a damage line the server printed with no attacker in it.
 *
 * `A shining spark strikes cave worm for 3 damage!` is the proc's own message
 * data with the target and the number substituted in. Nothing in the sentence
 * says whose weapon fired it, so the realm's item row has to.
 */
describe('the chance-on-hit an item carries', () => {
  /* `shimmering longsword` again: a bless to invoke and a proc that cannot be. */
  const LONGSWORD = {
    abilities: [
      [28, 1],
      [86, 50],
      [43, 114],
      [114, 40],
      [43, 170],
      [135, 10]
    ] as ReadonlyArray<readonly [number, number]>
  };

  it('reads the pair the realm states, with its percentage', () => {
    expect(itemHitProcs(LONGSWORD)).toEqual([{ spell: 170, chance: 40 }]);
  });

  /*
   * And never the bless. `[43, 114]` has no `PercentSpell` in front of it, so
   * it is the thing `use` invokes — reading it as a proc would have every
   * unattributed blow in the room credited to a weapon that fires nothing.
   */
  it('does not read a bare CastsSp as a proc', () => {
    expect(itemHitProcs({ abilities: [[43, 114]] })).toEqual([]);
  });

  it('says nothing about an item the realm has no row for', () => {
    expect(itemHitProcs({})).toEqual([]);
    expect(itemHitProcs({ abilities: [[28, 1]] })).toEqual([]);
  });

  /* Slot zero is the realm's empty cell, not a spell. */
  it('refuses a spell of zero', () => {
    expect(
      itemHitProcs({
        abilities: [
          [114, 40],
          [43, 0]
        ]
      })
    ).toEqual([]);
  });
});
