import { describe, expect, it } from 'vitest';

import {
  RealmBuildError,
  attackChances,
  buildRealm,
  castChances,
  indexItems,
  indexMobs,
  indexShops,
  indexSpells,
  indexRaces,
  indexItemNames,
  indexClasses,
  parseExit,
  placedItems,
  rowProfile
} from '../buildRealm';
import { realmKind } from '../RealmSource';
import type { RealmSource, RealmTable } from '../RealmSource';

/** A realm database made of literals, so the converter can be tested alone. */
function fake(tables: Record<string, Record<string, unknown>[]>): RealmSource {
  return {
    path: '/tmp/test.mdb',
    kind: 'mdb',
    tableNames: () => Object.keys(tables),
    table: (name): RealmTable | null => {
      const found = Object.entries(tables).find(
        ([key]) => key.toLowerCase() === name.toLowerCase()
      );
      if (!found) return null;
      return { name: found[0], columns: Object.keys(found[1][0] ?? {}), rows: found[1] };
    },
    close: () => {}
  };
}

const room = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  'Map Number': 1,
  'Room Number': 1,
  Name: 'Town Gates',
  ...over
});

describe('recognising a realm file', () => {
  it('takes the shapes the game and its tooling produce', () => {
    expect(realmKind('/x/realm.mdb')).toBe('mdb');
    expect(realmKind('/x/REALM.MDB')).toBe('mdb');
    expect(realmKind('/x/realm.accdb')).toBe('mdb');
    expect(realmKind('/x/realm.sqlite')).toBe('sqlite');
    expect(realmKind('/x/realm.db')).toBe('sqlite');
  });

  /* A wrong guess here is a confident, silent, empty realm. */
  it('refuses anything else rather than guessing', () => {
    expect(realmKind('/x/realm')).toBeNull();
    expect(realmKind('/x/realm.txt')).toBeNull();
  });

  /*
   * A zip is a container, not a shape: `openRealm` looks inside one and asks
   * this same question about what it finds. Saying `mdb` here would be claiming
   * a reader can be chosen before the archive has been opened.
   */
  it('is not what says a zip can be opened', () => {
    expect(realmKind('/x/realm.zip')).toBeNull();
  });
});

describe('reading an exit', () => {
  it('takes a destination', () => {
    expect(parseExit('1/41')).toEqual({ m: 1, r: 41 });
  });

  it('keeps the instruction verbatim, because it is what the player must do', () => {
    expect(parseExit('1/41 (Door [1000 picklocks/strength])')).toEqual({
      m: 1,
      r: 41,
      i: 'Door [1000 picklocks/strength]'
    });
  });

  it('reads "no exit" in every shape a database writes it', () => {
    for (const value of ['0', '', '   ', null, undefined]) {
      expect(parseExit(value)).toBeNull();
    }
  });

  it('refuses something it does not understand rather than inventing a room', () => {
    expect(parseExit('somewhere else')).toBeNull();
    expect(parseExit('1/')).toBeNull();
  });
});

describe('reading a room’s placed items', () => {
  it('takes the comma-terminated list the realm stores', () => {
    expect(placedItems('1410,1417,')).toEqual([1410, 1417]);
    expect(placedItems('939')).toEqual([939]);
  });

  it('reads nothing into an empty or missing cell', () => {
    expect(placedItems('')).toEqual([]);
    expect(placedItems(null)).toEqual([]);
    expect(placedItems(undefined)).toEqual([]);
  });

  it('keeps each item once, and drops what is not an item number', () => {
    expect(placedItems('12,12,-3,0,1.5,abc,,40,')).toEqual([12, 40]);
  });
});

describe('converting a realm', () => {
  const today = '2026-08-25';

  it('emits one line per addressable room', () => {
    const built = buildRealm(
      fake({ Rooms: [room(), room({ 'Room Number': 2, Name: 'Estwall Street' })] }),
      today
    );
    expect(built.lines).toHaveLength(2);
    expect(JSON.parse(built.lines[0]!)).toMatchObject({ m: 1, r: 1, n: 'Town Gates' });
  });

  it('sorts by map then room, so two readers of one database agree', () => {
    const built = buildRealm(
      fake({
        Rooms: [
          room({ 'Map Number': 2, 'Room Number': 1 }),
          room({ 'Map Number': 1, 'Room Number': 9 }),
          room({ 'Map Number': 1, 'Room Number': 2 })
        ]
      }),
      today
    );
    expect(built.lines.map((line) => JSON.parse(line)).map((r) => `${r.m}/${r.r}`)).toEqual([
      '1/2',
      '1/9',
      '2/1'
    ]);
  });

  /*
   * Skipped rather than given a zero: a defaulted address collides with every
   * other defaulted address at 0/0, which is worse than the room being absent.
   */
  it('skips a room with no address rather than defaulting one', () => {
    const built = buildRealm(
      fake({ Rooms: [room(), room({ 'Map Number': null, 'Room Number': null })] }),
      today
    );
    expect(built.lines).toHaveLength(1);
    expect(built.stats.rooms).toBe(1);
  });

  it('leaves out the optional columns it has nothing for', () => {
    const built = buildRealm(fake({ Rooms: [room({ Shop: '', Lair: '', Placed: '' })] }), today);
    const parsed = JSON.parse(built.lines[0]!);
    expect(parsed).not.toHaveProperty('s');
    expect(parsed).not.toHaveProperty('lair');
    expect(parsed).not.toHaveProperty('pl');
  });

  /*
   * `Rooms.Placed` — format 42. What the realm puts on the floor and puts
   * back every night, as ids, each one named: the room refers to the item the
   * way a shop refers to its stock.
   */
  it('reads what the realm places in a room, and names each item', () => {
    const built = buildRealm(
      fake({
        Rooms: [room({ Placed: '690,938,' }), room({ 'Room Number': 2, Placed: ' 690 , x,0,' })],
        Items: [
          { Number: 690, Name: 'log raft' },
          { Number: 938, Name: 'slag sign', Gettable: 0 }
        ]
      }),
      today
    );
    const [first, second] = built.lines.map((line) => JSON.parse(line));
    expect(first.pl).toEqual([690, 938]);
    // Padding survives, and what is not an item number is dropped, not guessed.
    expect(second.pl).toEqual([690]);
    expect(first).not.toHaveProperty('placed');
    expect(built.header.items?.map((item) => item.n)).toEqual(['log raft', 'slag sign']);
  });

  /*
   * A file with no rooms is a file somebody pointed at by mistake, and a client
   * that accepts it stops knowing where it is with nothing on screen saying why.
   */
  it('refuses a database with no Rooms table, and says what it has', () => {
    expect(() => buildRealm(fake({ Spells: [] }), today)).toThrow(RealmBuildError);
    try {
      buildRealm(fake({ Spells: [] }), today);
    } catch (error) {
      expect(String(error)).toContain('Spells');
    }
  });

  it('refuses a Rooms table with nothing addressable in it', () => {
    expect(() => buildRealm(fake({ Rooms: [{ Something: 'else' }] }), today)).toThrow(
      RealmBuildError
    );
  });

  it('counts what it found, so a conversion can be checked rather than trusted', () => {
    const built = buildRealm(
      fake({
        Rooms: [
          room({ N: '1/2' }),
          room({ 'Room Number': 2, E: '1/3 (Door [Key: 1124])' }),
          room({ 'Room Number': 3 })
        ]
      }),
      today
    );
    expect(built.stats).toMatchObject({ rooms: 3, withExits: 2, withInstructions: 1 });
  });
});

/*
 * A locked door says `Key: 1124`, which tells nobody anything. Only the items
 * some exit references are indexed, and provenance is best-effort: an entry
 * with neither a shop nor a monster is more honest than a guess.
 */
describe('naming the items an exit needs', () => {
  const source = fake({
    Items: [
      { Number: 1124, Name: 'jail key' },
      { Number: 9999, Name: 'irrelevant' }
    ],
    Shops: [{ Name: 'Locksmith', 'Item-1': 1124, 'Item-2': 5 }],
    Monsters: [{ Name: 'Sheriff Lionheart', 'DropItem-1': 1124 }]
  });

  it('names an item and says where it comes from', () => {
    const [entry] = indexItems(source, new Set([1124]));
    expect(entry).toEqual({
      id: 1124,
      n: 'jail key',
      shops: ['Locksmith'],
      mobs: ['Sheriff Lionheart']
    });
  });

  it('indexes only what an exit actually asks for', () => {
    expect(indexItems(source, new Set([1124]))).toHaveLength(1);
    expect(indexItems(source, new Set())).toEqual([]);
  });

  /* Saying the name and stopping beats guessing where to find it. */
  it('names an item with no known source, and claims nothing about it', () => {
    const [entry] = indexItems(fake({ Items: [{ Number: 7, Name: 'brass key' }] }), new Set([7]));
    expect(entry).toEqual({ id: 7, n: 'brass key' });
  });

  it('survives a database with no Shops or Monsters at all', () => {
    const [entry] = indexItems(fake({ Items: [{ Number: 7, Name: 'brass key' }] }), new Set([7]));
    expect(entry?.n).toBe('brass key');
  });

  it('reports an item it cannot name rather than dropping the reference', () => {
    const [entry] = indexItems(fake({ Items: [] }), new Set([7]));
    // The exit still says `Key: 7`; the map has to be able to say so.
    expect(entry).toEqual({ id: 7, n: '' });
  });
});

/**
 * Monster health, which the server never states and a fight is judged on.
 *
 * Keyed by *name* because a name is all the wire ever gives — the combat lines
 * carry `the giant rat` and never a record id — and the realm data is keyed by
 * id with several rows frequently sharing a name.
 */
describe('naming what a monster is worth in health', () => {
  /** The realm's numbers ride along from format 9; these assertions are about the rest. */
  /*
   * These cases are about the disposition columns, so the realm's own ids and
   * its undecoded `Type` are stripped: `ty` is carried for every row (format
   * 18) and asserting it here would make three tests about `Align` fail
   * whenever a fixture's `Type` changed.
   */
  const bare = (mobs: ReturnType<typeof indexMobs>) =>
    mobs.map(({ i: _ids, ty: _types, rw: _rows, ...rest }) => rest);

  /*
   * Format 32: each row answering for itself beside its number, so a lair —
   * or a name resolved by the room it stands in — is weighed by the row rather
   * than by the fold, which took the 830-HP gnoll scout for the 100-HP one
   * sharing its name.
   */
  it('keeps each row’s own numbers beside its number, in step with the ids', () => {
    const mobs = indexMobs(
      fake({
        Monsters: [
          {
            Number: 224,
            Name: 'gnoll scout',
            HP: 100,
            Align: 2,
            Type: 2,
            ArmourClass: 75,
            EXP: 340,
            'In Game': 1
          },
          {
            Number: 2204,
            Name: 'gnoll scout',
            HP: 830,
            Align: 3,
            Type: 0,
            ArmourClass: 40,
            EXP: 2000,
            'In Game': 1
          },
          { Number: 7, Name: 'gnoll scout', HP: 100, 'In Game': 1 }
        ]
      })
    );
    expect(mobs[0]).toMatchObject({ i: [224, 2204, 7], d: 'h', x: 1 });
    /*
     * The fold takes the worst of them — the hardest to hit, the least worth
     * killing — and each row keeps its own, which is the whole point: 75 AC
     * and 340 experience belong to row 224 and not to the 830-HP one.
     */
    expect(mobs[0]).toMatchObject({ ac: 75, xp: 340, hp: 100, hi: 830 });
    expect(mobs[0]?.rw).toEqual([
      { hp: 100, d: 'h', ac: 75, xp: 340 },
      { hp: 830, d: 'p', ac: 40, xp: 2000 },
      { hp: 100 }
    ]);
  });

  it('writes no per-row record for a name the realm places once', () => {
    const mobs = indexMobs(
      fake({ Monsters: [{ Number: 224, Name: 'gnoll scout', HP: 100, 'In Game': 1 }] })
    );
    // With one row the fold *is* the row, and writing it twice would be the
    // same fact in two places for every unshared name in the realm.
    expect(mobs[0]?.rw).toBeUndefined();
  });

  it('indexes each row’s own profile beside its number, absent for a row with none', () => {
    const scout = (over: Record<string, unknown>) => ({
      Name: 'gnoll scout',
      HP: 100,
      Align: 2,
      Type: 2,
      'In Game': 1,
      ...over
    });
    const swing = (accuracy: number) => ({
      'AttType-0': 1,
      'Att%-0': 100,
      'AttAcc-0': accuracy,
      'AttMin-0': 4,
      'AttMax-0': 15,
      'AttEnergy-0': 1000
    });
    const mobs = indexMobs(
      fake({
        Monsters: [
          scout({ Number: 224, ...swing(70) }),
          scout({ Number: 2204, ...swing(150) }),
          // The same swing as 224, so it shares 224's profile rather than
          // getting a third.
          scout({ Number: 300, ...swing(70) }),
          scout({ Number: 7 })
        ]
      })
    );
    expect(mobs[0]?.pf).toHaveLength(2);
    expect(mobs[0]).toMatchObject({ i: [224, 2204, 300, 7] });
    expect(mobs[0]?.rw?.map((row) => row.p)).toEqual([0, 1, 0, undefined]);
  });

  /*
   * Format 36. `rw` is written only where a name holds several rows, so a
   * uniquely named monster — which is what a boss is — had nowhere to keep
   * `Monsters.RegenTime`: a 1,500-point Gravedigger on an hour's clock was
   * priced as though it came back with the skeletons around it.
   */
  it('keeps a monster’s own clock on the fold, where the whole name agrees', () => {
    const mobs = indexMobs(
      fake({
        Monsters: [
          { Number: 790, Name: 'gravedigger', HP: 130, RegenTime: 1, GameLimit: 1, 'In Game': 1 }
        ]
      })
    );
    expect(mobs[0]).toMatchObject({ n: 'gravedigger', rt: 1 });
  });

  it('states no clock where the rows of a name disagree, rather than voting', () => {
    // `wild dog`: two lair rows on the room's own clock and one placed on an
    // hour's. Folding to the highest would price an ordinary lair row at one
    // an hour; folding to the lowest is the reassuring answer this fixed.
    const mobs = indexMobs(
      fake({
        Monsters: [
          { Number: 50, Name: 'wild dog', HP: 20, 'In Game': 1 },
          { Number: 376, Name: 'wild dog', HP: 20, 'In Game': 1 },
          { Number: 377, Name: 'wild dog', HP: 20, RegenTime: 1, GameLimit: 1, 'In Game': 1 }
        ]
      })
    );
    expect(mobs[0]?.rt).toBeUndefined();
    // The rows still carry their own, so a lair naming 377 prices it exactly.
    expect(mobs[0]?.rw?.map((row) => row.rt)).toEqual([undefined, undefined, 1]);
  });

  it('states no clock where no row has one', () => {
    const mobs = indexMobs(
      fake({ Monsters: [{ Number: 11, Name: 'skeleton', HP: 43, RegenTime: 0, 'In Game': 1 }] })
    );
    expect(mobs[0]?.rt).toBeUndefined();
  });

  /*
   * `RegenTime` is only a clock where `GameLimit` is non-zero. `RegenSlot`
   * consults `MobType.Regen` down that branch alone (`RegenSlot.cs:69`); with
   * `GameLimit == 0` the slot comes back on the room's own delay and the
   * column is never read. Stock's `minotaur` states 48 hours it does not keep,
   * and stands in 25 lairs on a five-minute delay.
   */
  it('ignores a RegenTime the server never reads, for want of a GameLimit', () => {
    const mobs = indexMobs(
      fake({
        Monsters: [
          { Number: 111, Name: 'minotaur', HP: 200, RegenTime: 48, GameLimit: 0, 'In Game': 1 }
        ]
      })
    );
    expect(mobs[0]?.rt).toBeUndefined();
    expect(mobs[0]?.rw).toBeUndefined();
  });

  it('carries the realm’s own numbers for every row sharing a name, so a lair resolves', () => {
    const mobs = indexMobs(
      fake({
        Monsters: [
          { Number: 1, Name: 'giant rat', HP: 12, 'In Game': 1 },
          { Number: 109, Name: 'giant rat', HP: 10, 'In Game': 1 }
        ]
      })
    );
    expect(mobs[0]?.i).toEqual([1, 109]);
  });

  it('indexes every monster, not the ones some exit happens to mention', () => {
    const mobs = indexMobs(
      fake({
        Monsters: [
          { Number: 1, Name: 'giant rat', HP: 12, 'In Game': 1 },
          { Number: 2, Name: 'lashworm', HP: 15, 'In Game': 1 }
        ]
      })
    );
    // Sorted by name, so a realm converted at runtime and one built by the
    // script produce byte-identical output.
    expect(bare(mobs)).toEqual([
      { n: 'giant rat', hp: 12 },
      { n: 'lashworm', hp: 15 }
    ]);
  });

  /*
   * Five monsters are called `cocoon` and they run from 100 to 250 health. A
   * name cannot choose between them, so the span is carried and the consumer
   * says so rather than printing one of the five as though it were the answer.
   */
  it('keeps the span when several rows share a name', () => {
    const mobs = indexMobs(
      fake({
        Monsters: [
          { Number: 1, Name: 'cocoon', HP: 100, 'In Game': 1 },
          { Number: 2, Name: 'Cocoon', HP: 250, 'In Game': 1 },
          { Number: 3, Name: 'cocoon', HP: 180, 'In Game': 1 }
        ]
      })
    );
    expect(bare(mobs)).toEqual([{ n: 'cocoon', hp: 100, hi: 250 }]);
  });

  /*
   * `In Game` is the realm builder's own flag for content that exists in the
   * table and not in the world. A retired row widening a live monster's span is
   * invisible from the outside.
   */
  it('leaves out rows the realm has switched off', () => {
    const mobs = indexMobs(
      fake({
        Monsters: [
          { Number: 1, Name: 'giant rat', HP: 12, 'In Game': 1 },
          { Number: 2, Name: 'giant rat', HP: 9000, 'In Game': 0 }
        ]
      })
    );
    expect(bare(mobs)).toEqual([{ n: 'giant rat', hp: 12 }]);
  });

  /* Absent and zero are both "this realm does not say", and neither is a bar. */
  it('refuses a maximum of zero rather than dividing by it later', () => {
    const mobs = indexMobs(
      fake({
        Monsters: [
          { Number: 1, Name: 'ghost', HP: 0, 'In Game': 1 },
          { Number: 2, Name: 'shade', 'In Game': 1 }
        ]
      })
    );
    expect(bare(mobs)).toEqual([]);
  });

  it('survives a realm with no Monsters table at all', () => {
    expect(indexMobs(fake({}))).toEqual([]);
  });

  /*
   * Whether a monster starts the fight, which is the question auto-combat turns
   * on. Read out of `Monsters.Align` and `Monsters.Type` exactly as
   * `Mob.ShouldMobAttackTarget` reads them — see `shared/mobs.ts`.
   */
  it('says whether a monster attacks on sight', () => {
    const mobs = indexMobs(
      fake({
        Monsters: [
          // ChaoticEvil, afoot.
          { Number: 1, Name: 'giant rat', HP: 12, Align: 2, Type: 2, 'In Game': 1 },
          // Neutral, afoot.
          { Number: 2, Name: 'kobold slave', HP: 39, Align: 3, Type: 0, 'In Game': 1 },
          // NeutralEvil, but stationary — which changes the answer.
          { Number: 3, Name: 'gate guard', HP: 80, Align: 5, Type: 3, 'In Game': 1 }
        ]
      })
    );
    expect(bare(mobs)).toEqual([
      { n: 'gate guard', hp: 80, d: 'p' },
      { n: 'giant rat', hp: 12, d: 'h' },
      { n: 'kobold slave', hp: 39, d: 'p' }
    ]);
  });

  /*
   * The column is `Align` in the `.mdb` every derivative distributes and
   * `Alignment` in the extraction the server itself loads — the same drift
   * `In Game` has. Accepting one of them would produce a realm whose monsters
   * are all silently peaceable.
   */
  it('reads the alignment column under either of its two names', () => {
    const mobs = indexMobs(
      fake({
        Monsters: [{ Number: 1, Name: 'wererat', HP: 300, Alignment: 2, Type: 2, 'In Game': 1 }]
      })
    );
    expect(bare(mobs)).toEqual([{ n: 'wererat', hp: 300, d: 'h' }]);
  });

  /*
   * Twenty-one names in the shipped realm cover rows that disagree, `giant rat`
   * among them. The worst of them is carried for a readout, and the flag is
   * what stops it being acted on as though it were the answer.
   */
  it('marks a name whose rows disagree, and carries the worst of them', () => {
    const mobs = indexMobs(
      fake({
        Monsters: [
          { Number: 1, Name: 'giant rat', HP: 12, Align: 2, Type: 2, 'In Game': 1 },
          { Number: 2, Name: 'giant rat', HP: 12, Align: 3, Type: 0, 'In Game': 1 }
        ]
      })
    );
    expect(bare(mobs)).toEqual([{ n: 'giant rat', hp: 12, d: 'h', x: 1 }]);
  });

  /*
   * What attacking one costs the character: ten evil points for a `Good` or
   * `LawfulGood` row and nothing for any other. Three answers rather than a
   * flag, because a name covers several rows — and the middle one is what keeps
   * the client's refusal from swallowing the commonest monster in the realm.
   */
  it('says what attacking one costs, in three answers', () => {
    const mobs = indexMobs(
      fake({
        Monsters: [
          // Every row good: attacking one always costs.
          { Number: 1, Name: 'village priest', HP: 200, Align: 0, Type: 3, 'In Game': 1 },
          { Number: 2, Name: 'village priest', HP: 200, Align: 4, Type: 3, 'In Game': 1 },
          // Two vicious and one tame, which is `giant rat` in the shipped realm.
          { Number: 3, Name: 'giant rat', HP: 12, Align: 2, Type: 2, 'In Game': 1 },
          { Number: 4, Name: 'giant rat', HP: 10, Align: 0, Type: 0, 'In Game': 1 },
          { Number: 5, Name: 'orc rogue', HP: 40, Align: 2, Type: 0, 'In Game': 1 }
        ]
      })
    );
    const by = new Map(mobs.map((entry) => [entry.n, entry]));
    expect(by.get('village priest')?.ep).toBe('a');
    expect(by.get('giant rat')?.ep).toBe('s');
    expect(by.get('orc rogue')?.ep).toBeUndefined();
  });

  /*
   * A realm that states no alignment at all says *nothing* about whether its
   * monsters attack, which has to reach the client as nothing known rather than
   * as a realm full of peaceable monsters.
   */
  it('writes no disposition for a realm that does not state one', () => {
    const mobs = indexMobs(
      fake({ Monsters: [{ Number: 1, Name: 'thing', HP: 10, 'In Game': 1 }] })
    );
    expect(bare(mobs)).toEqual([{ n: 'thing', hp: 10 }]);
  });
});

/**
 * What a shop stocks, which the client would otherwise have to spend a command
 * on `list` to learn.
 *
 * A shop is a property of a *room* and the realm data records which shop a room
 * holds, so this is the difference between "you are standing in a shop" and
 * "you are standing in a General Store that sells a lantern".
 */
describe('naming what a shop stocks', () => {
  const shops = () =>
    indexShops(
      fake({
        Shops: [
          {
            Number: 4,
            Name: 'General Store',
            'Markup%': 250,
            'Item-0': 12,
            'Item-1': 0,
            'Item-2': 34
          },
          // 175 of the 283 rows in the real table sell something; the rest are
          // placeholders, and one of them is literally called "Leave this blank".
          { Number: 5, Name: 'Leave this blank', 'Item-0': 0, 'Item-1': 0 }
        ]
      })
    );

  it('keeps the stocked slots and drops the empty ones', () => {
    expect(shops()).toEqual([{ id: 4, n: 'General Store', items: [12, 34], markup: 250 }]);
  });

  it('leaves out a shop that stocks nothing, rather than carrying it empty', () => {
    // A card saying "sells nothing" states a fact the realm data does not have.
    expect(shops().some((shop) => shop.n === 'Leave this blank')).toBe(false);
  });

  it('survives a realm with no Shops table at all', () => {
    expect(indexShops(fake({ Rooms: [room()] }))).toEqual([]);
  });

  /*
   * Who a place serves — format 35. The columns are in every shop row and
   * were read by nothing, so a client wanting to go and collect a level had
   * no way to pick a room (todo 18). `ClassRest` 0 is *anybody* and is left
   * out rather than written as a zero the reader would have to know means
   * nothing.
   */
  it('carries a training room band, its class restriction and its markup', () => {
    const [trainer] = indexShops(
      fake({
        Shops: [
          {
            Number: 26,
            Name: 'Ninja Training Room',
            ShopType: 8,
            MinLVL: 1,
            MaxLVL: 10,
            'Markup%': 300,
            ClassRest: 7
          }
        ]
      })
    );
    expect(trainer).toEqual({
      id: 26,
      n: 'Ninja Training Room',
      items: [],
      markup: 300,
      t: 8,
      min: 1,
      max: 10,
      cls: 7
    });
  });

  it('leaves an unrestricted trainer without a class, rather than carrying a zero', () => {
    const [trainer] = indexShops(
      fake({
        Shops: [
          { Number: 74, Name: 'Titan Trainer', ShopType: 8, MinLVL: 21, MaxLVL: 50, ClassRest: 0 }
        ]
      })
    );
    expect(trainer?.cls).toBeUndefined();
    expect(trainer?.min).toBe(21);
    expect(trainer?.max).toBe(50);
  });

  /* Item zero is the realm's empty slot, not an item. */
  it('never reads an empty slot as item zero', () => {
    const [shop] = indexShops(
      fake({ Shops: [{ Number: 1, Name: 'X', 'Item-0': 0, 'Item-1': 3 }] })
    );
    expect(shop?.items).toEqual([3]);
  });

  /*
   * The whole reason the item index grew: an exit's key and a shop's stock are
   * the same question — "what is item 12" — asked from two directions, and the
   * file only carries the answer once.
   */
  it('makes the items a shop stocks nameable in the built realm', () => {
    const built = buildRealm(
      fake({
        Rooms: [room({ Shop: 4 })],
        Shops: [{ Number: 4, Name: 'General Store', 'Item-0': 12 }],
        Items: [{ Number: 12, Name: 'lantern', Price: 2, Encum: 30 }]
      }),
      '2026-01-01'
    );
    expect(built.header.shops).toEqual([{ id: 4, n: 'General Store', items: [12] }]);
    // Named, priced, weighed — and it keeps its provenance, because the shop
    // that stocks it is now also the answer to "where do I get one".
    expect(built.header.items).toEqual([
      { id: 12, n: 'lantern', price: 2, enc: 30, shops: ['General Store'] }
    ]);
  });
});

/**
 * The spell reference. The whole table, for the reason the monster index takes
 * the whole table and the item index does not: an exit says in advance which
 * key it wants, and nothing says in advance which spell somebody will look up.
 */
describe('naming the spells a realm has', () => {
  it('keeps every named spell, with what the realm states about it', () => {
    const spells = indexSpells(
      fake({
        Spells: [
          { Number: 3, Name: 'Heal', Short: 'hea', ReqLevel: 2, ManaCost: 5, Dur: 0 },
          { Number: 1, Name: 'Light', Short: 'Light', EnergyCost: 1 }
        ]
      })
    );
    expect(spells).toEqual([
      // Sorted by id, like every other index, so two builds agree byte for byte.
      { id: 1, n: 'Light', energy: 1 },
      { id: 3, n: 'Heal', short: 'hea', level: 2, mana: 5 }
    ]);
  });

  /*
   * Absent is not zero. A spell that costs no mana and a spell whose cost the
   * realm does not record are different facts, and only one can be acted on.
   */
  it('omits a figure the realm does not state rather than writing zero', () => {
    const [spell] = indexSpells(fake({ Spells: [{ Number: 1, Name: 'Blink', ManaCost: 0 }] }));
    expect(spell).toEqual({ id: 1, n: 'Blink' });
  });

  it('skips a row with no name, which is a gap in the table', () => {
    expect(indexSpells(fake({ Spells: [{ Number: 1, Name: '' }] }))).toEqual([]);
  });

  it('survives a realm with no Spells table at all', () => {
    expect(indexSpells(fake({ Rooms: [room()] }))).toEqual([]);
  });

  /* Zero is the realm's *never resisted* and reads back as the cast that
     lands — the dangerous end, which is why absent is the right spelling. */
  it('keeps whether a spell can be resisted, and omits the realm’s never', () => {
    const spells = indexSpells(
      fake({
        Spells: [
          { Number: 1, Name: 'bolt', TypeOfResists: 2 },
          { Number: 2, Name: 'breathes', TypeOfResists: 0 }
        ]
      })
    );
    expect(spells).toEqual([
      { id: 1, n: 'bolt', res: 2 },
      { id: 2, n: 'breathes' }
    ]);
  });
});

/*
 * The five attack slot groups and the five between-round spell groups, read
 * as the server reads them — `MobType.GetAttackTypes`, `Mob.GetAttackType`
 * and the between-round loop in `TimedEventManager`.
 */
describe('how a monster fights', () => {
  /* The columns are cumulative thresholds walked by one roll: a roll above
     the last falls back to the first slot, and a threshold below the one
     before it can never fire. */
  it('turns the cumulative slot thresholds into the chance each slot is rolled', () => {
    expect(attackChances([100])).toEqual([1]);
    expect(attackChances([50, 100])).toEqual([0.5, 0.5]);
    expect(attackChances([20, 50, 100])).toEqual([0.2, 0.3, 0.5]);
    expect(attackChances([85, 100])).toEqual([0.85, 0.15]);
    expect(attackChances([70, 50])).toEqual([1, 0]);
    expect(attackChances([])).toEqual([]);
  });

  /* One roll per round, and the first slot it falls under fires. */
  it('turns the between-round percentages into the marginal chance each spell fires', () => {
    expect(castChances([10, 20, 40, 60])).toEqual([0.1, 0.1, 0.2, 0.2]);
    expect(castChances([100, 50])).toEqual([1, 0]);
    expect(castChances([0])).toEqual([0]);
  });

  const guardsman = (over: Record<string, unknown>): Record<string, unknown> => ({
    Number: 1,
    Name: 'guardsman',
    HP: 200,
    'In Game': 1,
    ...over
  });

  it('reads a blow, a cast in a blow’s place, and the between-round spells off one row', () => {
    const profile = rowProfile(
      guardsman({
        'AttType-0': 1,
        'Att%-0': 85,
        'AttAcc-0': 80,
        'AttMin-0': 8,
        'AttMax-0': 30,
        'AttEnergy-0': 1000,
        'AttHitSpell-0': 583,
        'AttType-1': 2,
        'Att%-1': 100,
        'AttAcc-1': 888,
        'AttMin-1': 100,
        'AttMax-1': 30,
        'AttEnergy-1': 1000,
        'MidSpell-0': 66,
        'MidSpell%-0': 10,
        'MidSpellLVL-0': 12,
        'MidSpell-1': 77,
        'MidSpell%-1': 30,
        'MidSpellLVL-1': 12
      })
    );
    expect(profile).toEqual({
      attacks: [
        { kind: 'melee', chance: 0.85, accuracy: 80, min: 8, max: 30, energy: 1000, onHit: 583 },
        { kind: 'spell', chance: 0.15, spell: 888, castChance: 1, level: 30, energy: 1000 }
      ],
      casts: [
        { spell: 66, chance: 0.1, level: 12 },
        { spell: 77, chance: 0.2, level: 12 }
      ]
    });
  });

  /* Only types 1 and 2 are loaded by `MobType.GetAttackTypes`; the shipped
     realm's one `3` — the first `giant rat` row — is a slot the server never
     rolls. A slot the walk gives no chance to is not an attack either. */
  it('ignores a slot of a type the server does not load, and one the roll never reaches', () => {
    expect(
      rowProfile(guardsman({ 'AttType-0': 3, 'Att%-0': 100, 'AttMin-0': 2, 'AttMax-0': 10 }))
    ).toBeNull();
    const profile = rowProfile(
      guardsman({
        'AttType-0': 1,
        'Att%-0': 100,
        'AttAcc-0': 10,
        'AttMin-0': 2,
        'AttMax-0': 10,
        'AttEnergy-0': 1000,
        'AttType-1': 1,
        'Att%-1': 50,
        'AttAcc-1': 10,
        'AttMin-1': 5,
        'AttMax-1': 5,
        'AttEnergy-1': 1000
      })
    );
    expect(profile?.attacks).toHaveLength(1);
  });

  it('writes one profile per distinct row, in row order, and none for a name that states nothing', () => {
    const swing = {
      'AttType-0': 1,
      'Att%-0': 100,
      'AttAcc-0': 10,
      'AttMin-0': 2,
      'AttMax-0': 12,
      'AttEnergy-0': 500
    };
    const mobs = indexMobs(
      fake({
        Monsters: [
          { Number: 1, Name: 'barmaid', HP: 200, 'In Game': 1, ...swing },
          { Number: 2, Name: 'barmaid', HP: 200, 'In Game': 1, ...swing },
          { Number: 3, Name: 'barmaid', HP: 200, 'In Game': 1, ...swing, 'AttMax-0': 20 },
          { Number: 4, Name: 'old man', HP: 10, 'In Game': 1 }
        ]
      })
    );
    expect(mobs[0]?.pf).toEqual([
      { a: [[1, 1, 10, 2, 12, 500, 0]] },
      { a: [[1, 1, 10, 2, 20, 500, 0]] }
    ]);
    expect(mobs[1]?.pf).toBeUndefined();
  });
});

/*
 * Recognising a thing is a different question from pricing it, and the two
 * shared a list until `You notice large sign, small sign here.` turned out to
 * name nothing the console knew: the realm's own furniture is sold by nobody
 * and needed by no exit, so the detail index — deliberately narrow — had never
 * heard of it.
 */
describe('naming every item, for a console that recognises one', () => {
  it('keeps names the detail index leaves out', () => {
    const source = fake({
      Items: [
        { Number: 1, Name: 'large sign' },
        { Number: 2, Name: 'small sign' },
        { Number: 3, Name: 'jail key' }
      ]
    });
    // The detail index is asked for one key and answers with one item.
    expect(indexItems(source, new Set([3])).map((item) => item.n)).toEqual(['jail key']);
    // The name index answers with all three, which is what the console needs.
    expect(indexItemNames(source)).toEqual(['jail key', 'large sign', 'small sign']);
  });

  it('folds two rows of one name together and skips a nameless gap', () => {
    expect(
      indexItemNames(
        fake({
          Items: [
            { Number: 1, Name: 'Torch' },
            { Number: 2, Name: 'torch' },
            { Number: 3, Name: '  ' }
          ]
        })
      )
    ).toEqual(['torch']);
  });

  it('survives a realm with no Items table at all', () => {
    expect(indexItemNames(fake({ Rooms: [room()] }))).toEqual([]);
  });
});

/*
 * The two words on every `look` at a player — `a Half-Ogre Mystic` — and the
 * only ones on that line the client could not answer about until v10.
 */
describe('naming the races and classes a realm offers', () => {
  it('keeps both ends of every stat range the realm states', () => {
    const races = indexRaces(
      fake({
        Races: [
          {
            Number: 10,
            Name: 'Half-Ogre',
            mSTR: 70,
            xSTR: 190,
            mINT: 20,
            xINT: 100,
            HPPerLVL: 1,
            ExpTable: 70
          }
        ]
      })
    );
    expect(races).toEqual([
      { id: 10, n: 'Half-Ogre', int: [20, 100], str: [70, 190], hpPerLevel: 1, expTable: 70 }
    ]);
  });

  /*
   * Half a range is not a range: a maximum with no minimum behind it draws as
   * a range starting at zero, which is a claim the realm never made.
   */
  it('drops a stat the realm states only one end of', () => {
    const [race] = indexRaces(fake({ Races: [{ Number: 1, Name: 'Human', xSTR: 145 }] }));
    expect(race).toEqual({ id: 1, n: 'Human' });
  });

  /*
   * Zero is "no bonus" and is left out rather than drawn as a bonus of none —
   * twelve of the shipped realm's thirteen races state it.
   */
  it('omits a hit-point bonus of zero rather than writing one', () => {
    const [race] = indexRaces(fake({ Races: [{ Number: 1, Name: 'Human', HPPerLVL: 0 }] }));
    expect(race).toEqual({ id: 1, n: 'Human' });
  });

  it('keeps a negative experience price, which is a real one', () => {
    /*
     * Stock MajorMUD prices a Thief at **-20**. `ExpTable` is a term of
     * `100 + race + class` — the multiplier the whole experience table is built
     * from — so a sign filter here charges every Thief a fifth more per level
     * than the realm does. Zero is still left out: zero contributes nothing to
     * a sum, unlike the hit-point bonus beside it, where zero is an absence
     * that would otherwise draw as a bonus of none.
     */
    expect(
      indexClasses(
        fake({
          Classes: [
            { Number: 8, Name: 'Thief', ExpTable: -20 },
            { Number: 1, Name: 'Warrior', ExpTable: 0 }
          ]
        })
      )
    ).toEqual([
      { id: 1, n: 'Warrior' },
      { id: 8, n: 'Thief', expTable: -20 }
    ]);
  });

  it('keeps a class in the three fields the realm states unambiguously', () => {
    expect(
      indexClasses(
        fake({
          Classes: [
            { Number: 15, Name: 'Mystic', ExpTable: 420, MageryLVL: 1, CombatLVL: 5 },
            // A Warrior casts nothing, and states that as level 0.
            { Number: 1, Name: 'Warrior', ExpTable: 320, MageryLVL: 0, CombatLVL: 6 }
          ]
        })
      )
    ).toEqual([
      { id: 1, n: 'Warrior', expTable: 320, combat: 6 },
      { id: 15, n: 'Mystic', expTable: 420, magery: 1, combat: 5 }
    ]);
  });

  /*
   * `MinHits`/`MaxHits` and `MageryType` are in the table and deliberately not
   * carried: the first is larger than the second in all fifteen rows and
   * nothing read so far says which way round they are, and the second speaks
   * only for zero. A guess published here would look exactly like a fact.
   */
  it('carries nothing for the two columns whose meaning is unsettled', () => {
    const [entry] = indexClasses(
      fake({ Classes: [{ Number: 1, Name: 'Warrior', MinHits: 7, MaxHits: 4, MageryType: 2 }] })
    );
    expect(entry).toEqual({ id: 1, n: 'Warrior' });
  });

  it('survives a realm with neither table', () => {
    expect(indexRaces(fake({ Rooms: [room()] }))).toEqual([]);
    expect(indexClasses(fake({ Rooms: [room()] }))).toEqual([]);
  });
});

/*
 * Armour is not a weapon is not a scroll, and `ItemType` decides which of the
 * other columns mean anything. The numbers are kept as the realm's numbers;
 * `shared/items.ts` turns them into words on the way out.
 */
describe('what kind of thing an item is', () => {
  const source = fake({
    Items: [
      {
        Number: 100,
        Name: 'quarterstaff',
        ItemType: 1,
        Worn: 1,
        Min: 2,
        Max: 12,
        Speed: 1200,
        StrReq: 30,
        Accy: 0,
        WeaponType: 1,
        ArmourClass: 10,
        UseCount: -1
      },
      {
        Number: 336,
        Name: 'padded boots',
        ItemType: 0,
        Worn: 5,
        ArmourClass: 10,
        DamageResist: 1,
        ArmourType: 1,
        Min: 0,
        Max: 0,
        UseCount: -1
      },
      { Number: 500, Name: 'scroll of flash', ItemType: 9, Worn: 0, UseCount: 1 },
      { Number: 7, Name: 'brass key' }
    ]
  });
  const built = new Map(indexItems(source, new Set([100, 336, 500, 7])).map((e) => [e.id, e]));

  it("carries a weapon's numbers and not armour's", () => {
    expect(built.get(100)).toEqual({
      id: 100,
      n: 'quarterstaff',
      type: 1,
      worn: 1,
      // `-1` is the realm saying *unlimited*, and it is kept from format 25 on:
      // absent used to mean both that and *nothing said*, which are opposite
      // answers to whether invoking the item costs anything.
      uses: -1,
      wpn: { min: 2, max: 12, spd: 1200, str: 30, kind: 1 }
    });
  });

  it("carries armour's numbers and not a weapon's", () => {
    expect(built.get(336)).toEqual({
      id: 336,
      n: 'padded boots',
      type: 0,
      worn: 5,
      uses: -1,
      arm: { ac: 10, dr: 1, kind: 1 }
    });
  });

  /*
   * `0` is the realm's empty cell and is left out; `-1` is *unlimited* and is
   * kept, because it is a fact and not an absence. Thirty-nine items in the
   * shipped realm are unlimited-use spell casters, and dropping the `-1` had
   * made every one of them read as though the realm had said nothing.
   */
  it('keeps a use count, including the realm’s unlimited', () => {
    expect(built.get(500)).toEqual({ id: 500, n: 'scroll of flash', type: 9, uses: 1 });
    expect(built.get(100)?.uses).toBe(-1);
    expect(built.get(7)?.uses).toBeUndefined();
  });

  /* A derivative without the column names no kinds rather than defaulting one. */
  it('claims nothing about a row that has no ItemType', () => {
    expect(built.get(7)).toEqual({ id: 7, n: 'brass key' });
  });
});

/* A bank and a temple are shops to the realm and not to a person. */
describe('what kind of shop a shop is', () => {
  it('keeps the realm number, and nothing for a placeholder', () => {
    const [bank, blank] = indexShops(
      fake({
        Shops: [
          { Number: 7, Name: 'Bank of Godfrey', ShopType: 7, 'Item-1': 12 },
          { Number: 8, Name: 'Leave this blank', ShopType: 0, 'Item-1': 12 }
        ]
      })
    );
    expect(bank).toEqual({ id: 7, n: 'Bank of Godfrey', items: [12], t: 7 });
    expect(blank).toEqual({ id: 8, n: 'Leave this blank', items: [12] });
  });
});

/* A bank stocks nothing and is still a bank; a stockless shop is a placeholder. */
describe('a place that sells nothing', () => {
  it('keeps a bank for its kind, and drops a bare placeholder', () => {
    const built = indexShops(
      fake({
        Shops: [
          { Number: 8, Name: 'Bank of Godfrey', ShopType: 7 },
          { Number: 9, Name: 'Leave this blank', ShopType: 10 }
        ]
      })
    );
    expect(built).toEqual([{ id: 8, n: 'Bank of Godfrey', items: [], t: 7 }]);
  });
});

/*
 * The levers, joined onto both ends — todo 01, format 23.
 *
 * The realm stores a room's levers in the same ten columns as its exits, and
 * every one was dropped until now. The join is what makes them usable: the room
 * holding a lever gains it as a word it answers, and a gated exit gains the
 * phrases where they are all within reach.
 */
describe('a lever the realm keeps in a direction column', () => {
  /** The reported room, verbatim: a concealed passage south and the lever here. */
  const smallChamber = () =>
    buildRealm(
      fake({
        Rooms: [
          room({
            'Map Number': 10,
            'Room Number': 4,
            Name: 'Small Chamber',
            S: '10/3 (Hidden/Needs 1 Actions, any order)',
            U: '10/5',
            W: 'Action#1 [on the S exit of this room]: pull lever, move lever, pull lev'
          }),
          room({ 'Map Number': 10, 'Room Number': 3, Name: 'Passage', N: '10/4' })
        ]
      }),
      '2026-09-06'
    );

  /** One line of the built world, read back — the shape the file actually has. */
  interface BuiltRoom {
    m: number;
    r: number;
    x: Record<string, { m: number; r: number; i?: string; a?: unknown[] } | undefined>;
    cmd?: unknown[];
  }

  const roomAt = (built: ReturnType<typeof buildRealm>, address: string): BuiltRoom =>
    built.lines
      .map((line) => JSON.parse(line) as BuiltRoom)
      .find((entry) => `${entry.m}/${entry.r}` === address)!;

  it('becomes a word the room holding it answers, saying what it opens', () => {
    const here = roomAt(smallChamber(), '10/4');
    expect(here.cmd).toEqual([
      {
        say: ['pull lever', 'move lever', 'pull lev'],
        opens: { room: '10/4', direction: 's' }
      }
    ]);
  });

  it('and the phrases land on the exit it opens', () => {
    const here = roomAt(smallChamber(), '10/4');
    expect(here.x['s']).toEqual({
      m: 10,
      r: 3,
      i: 'Hidden/Needs 1 Actions, any order',
      a: [{ say: ['pull lever', 'move lever', 'pull lev'] }]
    });
    expect(smallChamber().stats.levered).toBe(1);
    expect(smallChamber().stats.openableHere).toBe(1);
  });

  /* The column is a slot, not a direction: `W` here holds the `S` exit's lever. */
  it('does not become an exit of its own', () => {
    expect(Object.keys(roomAt(smallChamber(), '10/4').x)).toEqual(['s', 'u']);
  });

  /*
   * The other shape, and the reason the exit gets nothing: a detour to another
   * room is a route this planner does not plan, so the phrases stay off the
   * exit and only the room holding the lever says what it does.
   */
  it('records where a lever is when it is not in the room the exit leaves', () => {
    const built = buildRealm(
      fake({
        Rooms: [
          room({
            'Map Number': 1,
            'Room Number': 1331,
            Name: 'Inner Gate',
            N: '1/1375 (Hidden/Needs 1 Actions, any order)',
            E: '1/1339'
          }),
          room({
            'Map Number': 1,
            'Room Number': 1339,
            Name: 'Guardroom',
            W: '1/1331',
            N: 'Action [on the N exit of room 1/1331]: pull lever, push lever'
          }),
          room({ 'Map Number': 1, 'Room Number': 1375, Name: 'Courtyard', S: '1/1331' })
        ]
      }),
      '2026-09-06'
    );
    expect(roomAt(built, '1/1339').cmd).toEqual([
      { say: ['pull lever', 'push lever'], opens: { room: '1/1331', direction: 'n' } }
    ]);
    // The exit knows where the lever is, so the client can say so — and knows
    // it is not here, so nothing prices it as openable in place.
    expect(roomAt(built, '1/1331').x['n']!.a).toEqual([
      { say: ['pull lever', 'push lever'], at: { map: 1, room: 1339 } }
    ]);
    expect(built.stats.openableHere).toBe(0);
  });

  /*
   * 28 of the shipped realm's 217 gated exits state a count no number of levers
   * matches — one says 1,278. Sending the levers that were found would be a
   * command spent on a passage that stays shut, so the exit keeps the pricing
   * it has always had.
   */
  it('refuses the join when the realm’s own count disagrees', () => {
    const built = buildRealm(
      fake({
        Rooms: [
          room({
            'Map Number': 2,
            'Room Number': 1,
            Name: 'Vault',
            S: '2/2 (Hidden/Needs 3 Actions, specific order)',
            W: 'Action#1 [on the S exit of this room]: twist knot'
          }),
          room({ 'Map Number': 2, 'Room Number': 2, Name: 'Inner Vault', N: '2/1' })
        ]
      }),
      '2026-09-06'
    );
    expect(roomAt(built, '2/1').x['s']!.a).toBeUndefined();
    // The room still answers the word: what it opens is a fact either way.
    expect(roomAt(built, '2/1').cmd).toHaveLength(1);
    expect(built.stats.openableHere).toBe(0);
  });

  /* `Action#n` is the order a `specific order` exit wants them pulled in. */
  it('keeps several levers in the realm’s own order', () => {
    const built = buildRealm(
      fake({
        Rooms: [
          room({
            'Map Number': 7,
            'Room Number': 20,
            Name: 'Knotted Hall',
            SW: '7/21 (Hidden/Needs 2 Actions, specific order)',
            W: 'Action#2 [on the SW exit of this room]: push knot',
            E: 'Action#1 [on the SW exit of this room]: twist knot, turn knot'
          }),
          room({ 'Map Number': 7, 'Room Number': 21, Name: 'Alcove', NE: '7/20' })
        ]
      }),
      '2026-09-06'
    );
    expect(roomAt(built, '7/20').x['sw']!.a).toEqual([
      { say: ['twist knot', 'turn knot'] },
      { say: ['push knot'] }
    ]);
  });
});
