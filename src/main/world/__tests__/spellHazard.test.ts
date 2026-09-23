import { describe, expect, it } from 'vitest';

import { resolveHazard } from '../spellHazard';
import { HAZARD_ABILITY } from '../../../shared/abilities';

/**
 * The tables the reader walks, hand-written.
 *
 * Driven off fixtures rather than off the shipped realm because the arithmetic
 * is the claim: a claim asserted only against a file that ships is a claim
 * nobody can watch fail. The shipped realm gets its own survey at the bottom,
 * for the numbers this reader's prices are a claim *about*.
 */
const spells = (
  rows: Record<number, { abilities: Array<[number, number]>; power?: [number, number] }>
) =>
  new Map(
    Object.entries(rows).map(([id, row]) => [
      Number(id),
      { abilities: row.abilities, power: row.power ?? ([0, 0] as [number, number]) }
    ])
  );

const blocks = (rows: Record<number, string>) =>
  new Map(Object.entries(rows).map(([id, action]) => [Number(id), action]));

describe('what a room’s spell does to whoever stands in it', () => {
  it('reads a plain magnitude off the spell’s own columns', () => {
    // `freezing cold`: Damage with a zero value and the figure in MinBase –
    // MaxBase, which is where 1,410 of the realm's spells put it.
    const hazard = resolveHazard(
      1,
      spells({ 1: { abilities: [[HAZARD_ABILITY.damage, 0]], power: [1, 4] } }),
      blocks({})
    );
    expect(hazard).toMatchObject({ damage: 3, unread: false, avoidedBy: [] });
  });

  it('prefers the ability’s own value where it states one', () => {
    // `abil.Sum == 0 ? rolledPower : abil.Sum` — the server's own choice.
    const hazard = resolveHazard(
      1,
      spells({ 1: { abilities: [[HAZARD_ABILITY.damage, 40]], power: [1, 4] } }),
      blocks({})
    );
    expect(hazard.damage).toBe(40);
  });

  /*
   * The whole reason this reader exists. `river damage` carries no magnitude
   * at all: it is a script that stops if you are carrying a boat and otherwise
   * casts `battered` for 10–20. The router priced the eight hundred and
   * forty-five rooms of it at one step each.
   */
  it('follows a script into the spell it casts, and names what stops it', () => {
    const hazard = resolveHazard(
      753,
      spells({
        753: { abilities: [[HAZARD_ABILITY.textBlock, 2750]] },
        754: { abilities: [[HAZARD_ABILITY.damage, 0]], power: [10, 20] }
      }),
      blocks({
        2750: 'failitem 690:failitem 691:failitem 1181:failitem 3609:message 2096:cast 754'
      })
    );
    expect(hazard.damage).toBe(15);
    expect(hazard.avoidedBy).toEqual([690, 691, 1181, 3609]);
    expect(hazard.unread).toBe(false);
  });

  it('follows a random branch to the block behind it, both spellings', () => {
    const table = spells({
      1: { abilities: [[HAZARD_ABILITY.textBlock, 10]] },
      2: { abilities: [[HAZARD_ABILITY.poison, 25]] }
    });
    expect(resolveHazard(1, table, blocks({ 10: 'random 11', 11: 'cast 2' })).damage).toBe(25);
    expect(resolveHazard(1, table, blocks({ 10: 'random 90 11', 11: 'cast 2' })).damage).toBe(25);
  });

  it('records a spell that stops it without ever pricing on one', () => {
    const hazard = resolveHazard(
      683,
      spells({ 683: { abilities: [[HAZARD_ABILITY.textBlock, 2653]] } }),
      blocks({ 2653: 'failspell 711 2654:random 2655', 2655: 'message 1' })
    );
    expect(hazard.avoidedBySpell).toEqual([711]);
    expect(hazard.avoidedBy).toEqual([]);
  });

  /*
   * Unknown is never the reassuring answer, and here the reassuring answer is
   * *walk through it for free* — which is exactly what an unread `TextBlock`
   * bought before this existed.
   */
  /*
   * `checkspell <spell> <block>` is `failspell`'s shape (todo 02, realm
   * format 45): `TextBlockPart.cs:479` returns `Failed` whatever the answer
   * and runs the block only for a character the spell is *not* on, and
   * `ExecuteOnMatch` breaks the line on `Failed` — so the block is the whole
   * of what the room does, and the spell is what stops it.
   *
   * The desert, verbatim in shape: room spell 683's block is
   * `checkspell 711 2654:random 2655`, and 2654 is
   * `failitem 1180:cast 712:…`. Live, the sentence stopped printing the
   * moment a waterskin was drunk — 24 of them before, none across the next
   * 26 desert rooms.
   */
  it('reads a spell gate as what stops the room, and follows the block behind it', () => {
    const desert = resolveHazard(
      683,
      spells({
        683: { abilities: [[HAZARD_ABILITY.textBlock, 2653]] },
        712: { abilities: [[HAZARD_ABILITY.damage, 13]] }
      }),
      blocks({
        2653: 'checkspell 711 2654:random 2655',
        2654: 'failitem 1180:cast 712:random 2655',
        // The roll table the desert's own harm ends in: mostly nothing.
        2655: '87:addexp 0\n100:message 2018'
      })
    );
    expect(desert).toMatchObject({
      damage: 13,
      avoidedBy: [1180],
      avoidedBySpell: [711],
      unread: false
    });
  });

  /*
   * A gate on *level* says which character, and the router is planning for
   * one (todo 01, realm format 46). Paradigm's desert: `86:maxlevel 19:cast
   * 713` is a one-in-a-hundred sandstorm that cannot touch a level 21
   * character, and the plan said *it moves you somewhere else* on 979 rooms.
   */
  it('records the level band a gated effect sits behind, per effect', () => {
    const desert = resolveHazard(
      683,
      spells({
        683: { abilities: [[HAZARD_ABILITY.textBlock, 2653]] },
        713: { abilities: [[HAZARD_ABILITY.teleportRoom, 0]] }
      }),
      blocks({
        2653: 'failspell 711 2654:random 2655',
        // The roll table: nothing, then the gated sandstorm, then a summons
        // that is gated by nothing at all.
        2655: '85:addexp 0\n86:maxlevel 19:cast 713\n100:summon 570'
      })
    );
    expect(desert.relocates).toBe(true);
    expect(desert.summons).toBe(true);
    // The teleport is banded; the summons on the next line is not — a gate
    // governs the rest of its own line and nothing under it.
    expect(desert.levels).toEqual({ relocates: { max: 19 } });
  });

  /*
   * And the merge is the generous direction: an effect that can reach this
   * character by any path is one it can reach.
   */
  it('drops the band for an effect recorded outside a gate as well', () => {
    const both = resolveHazard(
      1,
      spells({
        1: { abilities: [[HAZARD_ABILITY.textBlock, 10]] },
        2: { abilities: [[HAZARD_ABILITY.teleportRoom, 0]] }
      }),
      blocks({ 10: 'maxlevel 19:cast 2\n100:cast 2' })
    );
    expect(both.relocates).toBe(true);
    expect(both.levels.relocates).toBeUndefined();
  });

  it('calls a verb it cannot evaluate unread rather than harmless', () => {
    const hazard = resolveHazard(
      1,
      spells({ 1: { abilities: [[HAZARD_ABILITY.textBlock, 10]] } }),
      blocks({ 10: 'nomonsters:testskill 34 4021' })
    );
    expect(hazard).toMatchObject({ damage: 0, unread: true });
  });

  /*
   * A gate on who the character is decides whether the rest of the line runs
   * for *them*, so what stands behind it happens to somebody and the reader
   * follows it (format 43). The oasis pools: `checkspell 512 4099:cast 515`,
   * where 515 removes the spell and hurts nobody — read as a hazard on eight
   * rooms of every route to the Golden Spire while `checkspell` was unread.
   */
  it('follows a gate on the character and reads what stands behind it', () => {
    const harmless = resolveHazard(
      1,
      spells({
        1: { abilities: [[HAZARD_ABILITY.textBlock, 10]] },
        2: {
          abilities: [
            [153, 3],
            [122, 3]
          ]
        }
      }),
      // 4099, the block the pools run for a character not holding breath, is empty.
      blocks({ 10: 'checkspell 3 11:cast 2', 11: '' })
    );
    /*
     * The spell is recorded (todo 02) and the pools are still nothing: a
     * hazard with no damage, no teleport, no summons and nothing unread is
     * not written out at all, so what `avoidedBySpell` says about a room that
     * does nothing is never read by anybody.
     */
    expect(harmless).toMatchObject({ damage: 0, unread: false, avoidedBySpell: [3] });

    // And the desert: a sandstorm behind `maxlevel 19` still moves *somebody*.
    const desert = resolveHazard(
      1,
      spells({
        1: { abilities: [[HAZARD_ABILITY.textBlock, 10]] },
        2: { abilities: [[HAZARD_ABILITY.teleportRoom, 0]] }
      }),
      blocks({ 10: 'maxlevel 19:cast 2' })
    );
    expect(desert).toMatchObject({ relocates: true, unread: false });

    // The block a spell gate runs for a character without the spell is what
    // that character gets, so it is followed; an empty block the realm holds
    // is nothing, and only an id the table lacks is unread.
    const behind = resolveHazard(
      1,
      spells({
        1: { abilities: [[HAZARD_ABILITY.textBlock, 10]] },
        2: { abilities: [[HAZARD_ABILITY.damage, 0]], power: [3, 3] }
      }),
      blocks({ 10: 'failspell 7 11:message 5', 11: 'cast 2' })
    );
    expect(behind).toMatchObject({ damage: 3, unread: false, avoidedBySpell: [7] });
    const empty = resolveHazard(
      1,
      spells({ 1: { abilities: [[HAZARD_ABILITY.textBlock, 10]] } }),
      blocks({ 10: 'checkspell 7 11:message 5', 11: '' })
    );
    // The spell is recorded here too (todo 02); the block behind it being
    // empty is what makes the room harmless, and a harmless room is never
    // written out at all.
    expect(empty).toMatchObject({ damage: 0, unread: false, avoidedBySpell: [7] });
    const lacking = resolveHazard(
      1,
      spells({ 1: { abilities: [[HAZARD_ABILITY.textBlock, 10]] } }),
      blocks({ 10: 'checkspell 7 11:message 5' })
    );
    expect(lacking.unread).toBe(true);

    // A gate before a wound is still a wound, at the wound's own figure.
    const wound = resolveHazard(
      1,
      spells({
        1: { abilities: [[HAZARD_ABILITY.textBlock, 10]] },
        2: { abilities: [[HAZARD_ABILITY.damage, 0]], power: [4, 8] }
      }),
      blocks({ 10: 'checkitem 1607:cast 2' })
    );
    expect(wound).toMatchObject({ damage: 6, unread: false });
  });

  /*
   * `summon` is a verb this reader understands: a monster put in the room,
   * which is what a lair does. Read as a fact and said as one, rather than
   * as a chain that could not be followed (todo 01, 2026-09-10).
   */
  it('reads a summons as a summons, not as unread', () => {
    const hazard = resolveHazard(
      1,
      spells({ 1: { abilities: [[HAZARD_ABILITY.textBlock, 10]] } }),
      blocks({ 10: 'nomonsters:summon 4021' })
    );
    expect(hazard).toMatchObject({ damage: 0, summons: true, unread: false });
  });

  /*
   * A roll table — the Silvermere spell (todo 01): `random 9056`, where
   * 9056 is a list of lines each led by a cumulative threshold, and one roll
   * of a hundred picks the first at or under it. 77% nothing, four percent
   * for one message, two for the next: scenery, and it was called unread in
   * 29 rooms because `77` is not a verb.
   */
  it('reads a roll table as the dice it is', () => {
    const table = spells({ 918: { abilities: [[HAZARD_ABILITY.textBlock, 9053]] } });
    const silvermere = blocks({
      9053: 'random 9056',
      9056: '77:addexp 0\n81:message 2645\n83:message 2646\n100:message 2650'
    });
    expect(resolveHazard(918, table, silvermere)).toMatchObject({
      damage: 0,
      summons: false,
      unread: false
    });
  });

  it('follows every line of a roll table at full weight', () => {
    const table = spells({
      915: { abilities: [[HAZARD_ABILITY.textBlock, 9054]] },
      2: { abilities: [[HAZARD_ABILITY.poison, 25]] }
    });
    const darkwood = blocks({
      9054: 'random 9055',
      9055: '70:addexp 0\n95:message 2654:random 9069\n100:message 2655:cast 2',
      9069: '70:addexp 0\n80:summon 48\n100:summon 49'
    });
    expect(resolveHazard(915, table, darkwood)).toMatchObject({
      damage: 25,
      summons: true,
      unread: false
    });
  });

  it('and a block the realm does not hold is unread too', () => {
    const hazard = resolveHazard(
      1,
      spells({ 1: { abilities: [[HAZARD_ABILITY.textBlock, 99]] } }),
      blocks({})
    );
    expect(hazard.unread).toBe(true);
  });

  /* `TextBlock 0` is the realm's *no script*, not a script it lost. */
  it('reads a text block of zero as no script at all', () => {
    const hazard = resolveHazard(
      1,
      spells({ 1: { abilities: [[HAZARD_ABILITY.textBlock, 0]], power: [5160, 5160] } }),
      blocks({})
    );
    expect(hazard).toMatchObject({ damage: 0, unread: false });
  });

  /*
   * A power with no ability that spends it is not damage. `bristlewood` states
   * `5160` in `MinBase` and `MaxBase` and does nobody any harm, and reading a
   * power as a wound would have walled 416 rooms of forest.
   */
  it('never reads a magnitude as damage without an ability that spends it', () => {
    const hazard = resolveHazard(
      1,
      spells({ 1: { abilities: [[115, 66]], power: [5160, 5160] } }),
      blocks({})
    );
    expect(hazard.damage).toBe(0);
  });

  it('says a spell that moves you does, rather than pricing it as harm', () => {
    const hazard = resolveHazard(
      1,
      spells({ 1: { abilities: [[HAZARD_ABILITY.teleportRoom, 400]] } }),
      blocks({})
    );
    expect(hazard).toMatchObject({ relocates: true, damage: 0, unread: false });
  });

  it('terminates on a chain that leads back to itself', () => {
    const hazard = resolveHazard(
      1,
      spells({
        1: { abilities: [[HAZARD_ABILITY.textBlock, 10]] },
        2: { abilities: [[HAZARD_ABILITY.textBlock, 10]] }
      }),
      blocks({ 10: 'cast 1:cast 2' })
    );
    expect(hazard.damage).toBe(0);
  });

  /*
   * **The chain a spell hands on when it *runs out* is not one tick of it.**
   * `freezing water` ends in `holding breath` (25 ticks), which ends in
   * `drowning` (5), which ends in `drowned to death` — power 9,999. Following
   * it and keeping the largest magnitude priced a single pass through the
   * water at certain death and walled 145 rooms across the two shipped worlds.
   * The router prices a pass, so the chain is not walked — and it is not free
   * either, because what is at the end of it is worse than what was read.
   */
  it('does not price what a spell hands on when it ends, and does not call it harmless', () => {
    const hazard = resolveHazard(
      1,
      spells({
        1: { abilities: [[HAZARD_ABILITY.endCast, 2]] },
        2: { abilities: [[HAZARD_ABILITY.damage, 0]], power: [9999, 9999] }
      }),
      blocks({})
    );
    expect(hazard).toMatchObject({ damage: 0, unread: true });
  });

  it('keeps what it did read when it hands on as well', () => {
    const hazard = resolveHazard(
      1,
      spells({
        1: {
          abilities: [
            [HAZARD_ABILITY.damage, 0],
            [HAZARD_ABILITY.endCast, 2]
          ],
          power: [2, 4]
        },
        2: { abilities: [[HAZARD_ABILITY.damage, 0]], power: [9999, 9999] }
      }),
      blocks({})
    );
    expect(hazard).toMatchObject({ damage: 3, unread: true });
  });

  /* A negative heal is a wound by another name — `damnation` taught it. */
  it('reads a negative heal as damage', () => {
    const hazard = resolveHazard(
      1,
      spells({ 1: { abilities: [[HAZARD_ABILITY.heal, -12]] } }),
      blocks({})
    );
    expect(hazard.damage).toBe(12);
  });
});
