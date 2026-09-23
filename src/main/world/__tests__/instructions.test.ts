import { describe, expect, it } from 'vitest';

import { parseAction, parseInstruction } from '../instructions';

/**
 * Every string here was taken from the realm database, not invented. The
 * vocabulary was surveyed with a `SELECT DISTINCT` over all ten exit columns
 * before any of this was written.
 */
describe('parseInstruction', () => {
  it('returns null for no instruction', () => {
    expect(parseInstruction(undefined)).toBeNull();
    expect(parseInstruction('')).toBeNull();
    expect(parseInstruction('   ')).toBeNull();
  });

  it('reads a plain door', () => {
    expect(parseInstruction('Door')).toMatchObject({ kind: 'door', raw: 'Door' });
  });

  it('reads a door with a pick difficulty', () => {
    const r = parseInstruction('Door [1000 picklocks/strength]');
    expect(r).toMatchObject({ kind: 'door', pickDifficulty: 1000 });
  });

  it('reads a door pickable by any skill at all', () => {
    expect(parseInstruction('Door [any picklocks/strength]')?.pickDifficulty).toBe(0);
    expect(parseInstruction('Door [any picklocks/strength]')?.bashDifficulty).toBe(0);
  });

  /*
   * The bracket comes in two shapes and they are not the same fact. 89 exits
   * in the shipped realm say `[or N picklocks]` with no `/strength` at all —
   * every one of them read as *no skill substitutes for the key*, because the
   * pattern that looked for them required the word the realm had left out.
   */
  it('separates a lock only picklocks open from one strength opens too', () => {
    const both = parseInstruction('Door [41 picklocks/strength]');
    expect(both).toMatchObject({ pickDifficulty: 41, bashDifficulty: 41 });

    const pickOnly = parseInstruction('Key: 2126 [or 157 picklocks]');
    expect(pickOnly).toMatchObject({ kind: 'key', keyId: 2126, pickDifficulty: 157 });
    expect(pickOnly?.bashDifficulty).toBeUndefined();

    expect(parseInstruction('Key: 1416 [or any picklocks]')?.pickDifficulty).toBe(0);
    expect(parseInstruction('Key: 1416 [or any picklocks]')?.bashDifficulty).toBeUndefined();
  });

  it('reads a keyed door and the skill that substitutes for the key', () => {
    const r = parseInstruction('Key: 1124 [or 301 picklocks/strength]');
    expect(r).toMatchObject({ kind: 'key', keyId: 1124, pickDifficulty: 301, bashDifficulty: 301 });
  });

  /*
   * Both ends can be written as "unset", with two different sentinels, and
   * taking either literally is a routing bug rather than a wording one: a
   * maximum of 0 refuses everybody, and four exits in the shipped realm say
   * `Level: 37 to 0`. See the note in `instructions.ts` for the whole survey.
   */
  it('reads a level range, and both ways of writing no limit', () => {
    expect(parseInstruction('Level: 66 to 255')).toMatchObject({
      kind: 'level',
      minLevel: 66,
      maxLevel: 255
    });
    // `999` at the top is no ceiling — seven exits in the shipped realm.
    expect(parseInstruction('Level: 10 to 999')).toEqual({
      kind: 'level',
      raw: 'Level: 10 to 999',
      minLevel: 10
    });
    // A zero at either end is the realm leaving it unset.
    expect(parseInstruction('Level: 0 to 5')).toEqual({
      kind: 'level',
      raw: 'Level: 0 to 5',
      maxLevel: 5
    });
    expect(parseInstruction('Level: 37 to 0')).toEqual({
      kind: 'level',
      raw: 'Level: 37 to 0',
      minLevel: 37
    });
    // And `0 to 0` is no gate at all, which is what two exits in the shipped
    // realm mean by it — read literally they admitted nobody.
    expect(parseInstruction('Level: 0 to 0')).toEqual({ kind: 'level', raw: 'Level: 0 to 0' });
  });

  it('reads the command list from a Text exit', () => {
    // The most important case: these exits are not walked with a direction at
    // all, so a route that emits `w` here simply does not work.
    const r = parseInstruction('Text: go crimson, enter crimson, go crimson portal');
    expect(r?.kind).toBe('text');
    expect(r?.commands).toEqual(['go crimson', 'enter crimson', 'go crimson portal']);
  });

  it('reads trap damage', () => {
    expect(parseInstruction('Trap, 30 damage')).toMatchObject({ kind: 'trap', damage: 30 });
  });

  it('distinguishes a searchable hidden exit from one that needs actions', () => {
    expect(parseInstruction('Hidden/Searchable')).toMatchObject({
      kind: 'hidden',
      searchable: true
    });
    expect(parseInstruction('Hidden/Needs 2 Actions, any order')).toMatchObject({
      kind: 'hidden',
      searchable: false
    });
    expect(parseInstruction('Hidden/Unknown')?.searchable).toBe(false);
  });

  it('classifies the remaining kinds seen in the data', () => {
    const cases: Array<[string, string]> = [
      ['Toll', 'toll'],
      ['Item', 'item'],
      ['Ticket/Item', 'item'],
      ['Class', 'class'],
      ['Race', 'race'],
      ['Alignment', 'alignment'],
      ['Ability', 'ability'],
      ['Cast', 'cast'],
      ['Spell', 'spell'],
      ['Timed', 'timed']
    ];
    for (const [raw, kind] of cases) {
      expect(parseInstruction(raw)?.kind, raw).toBe(kind);
    }
  });

  it('keeps an unrecognised instruction rather than dropping it', () => {
    // Dropping it would turn a gated exit into a free one, which is the more
    // dangerous error: a route would walk the player into a wall and stall.
    const r = parseInstruction('Something The Exporter Invented');
    expect(r?.kind).toBe('unknown');
    expect(r?.raw).toBe('Something The Exporter Invented');
  });
});

/*
 * The toll's price, and its unit.
 *
 * The realm writes a bare number; the wire says what it means. `Toll: 5` on the
 * Town Gates answered `You do not have enough to cover the toll of 5 gold
 * crowns.` against a purse of `0 copper farthings` (player session log,
 * 2026-08-30), so the number is gold and is stored as copper — the unit
 * `Traveller.wealth` is counted in.
 */
describe('what a toll charges', () => {
  it('reads the amount and converts it out of gold', () => {
    expect(parseInstruction('Toll: 5')?.tollCopper).toBe(500);
    expect(parseInstruction('Toll: 10000')?.tollCopper).toBe(1_000_000);
  });

  /* Zero is an answer, and absent is not: a gate that charges nothing must not
     read as one whose price the realm failed to record. */
  it('keeps a toll of nothing as nothing', () => {
    expect(parseInstruction('Toll: 0')?.tollCopper).toBe(0);
  });

  it('leaves the price absent when the realm states none', () => {
    expect(parseInstruction('Toll')?.tollCopper).toBeUndefined();
  });
});

/*
 * The levers — todo 01, format 23.
 *
 * The realm stores what a room *does* in the same ten columns it stores where
 * it *leads*, and `parseExit` returns null for every one, so the converter had
 * dropped all 299 of them in each database since it was written.
 */
describe('a lever in a direction column', () => {
  /* 10/4's own `W` column, verbatim — the reported room. */
  it('reads the exit it opens, and every phrase the realm accepts', () => {
    expect(
      parseAction('Action#1 [on the S exit of this room]: pull lever, move lever, pull lev')
    ).toEqual({
      direction: 's',
      index: 1,
      say: ['pull lever', 'move lever', 'pull lev']
    });
  });

  /* 1/1339's `N` column: the lever is here and the exit is two rooms away. */
  it('reads a lever whose exit is in another room', () => {
    expect(
      parseAction('Action [on the N exit of room 1/1331]: pull lever, push lever, move lever')
    ).toEqual({
      direction: 'n',
      map: 1,
      room: 1331,
      say: ['pull lever', 'push lever', 'move lever']
    });
  });

  /* A bare `Action` is the only one, so its order is not a fact the data states. */
  it('leaves the index absent where the realm does not number it', () => {
    expect(parseAction('Action [on the D exit of this room]: pull grate')?.index).toBeUndefined();
  });

  /*
   * Three cells in each database name an exit and no phrase. A lever with no
   * word to say is not a lever anybody can pull.
   */
  /*
   * `(Item: 815)` closes the phrase list on 172 of Paradigm's lever cells and
   * 170 of stock's (2026-09-07): the item the action needs carried, written by
   * the realm's editor after the last phrase. The server checks the pack
   * before the action fires — `You don't have <item> to use!` — so it is read
   * off as a number and never left inside a phrase the walker would say.
   */
  it('reads the item a lever needs off the end of its phrases', () => {
    const lever = parseAction(
      'Action [on the N exit of this room]: hold up talisman, hold up amber talisman, lift up talisman (Item: 815)'
    );
    expect(lever?.item).toBe(815);
    expect(lever?.say).toEqual(['hold up talisman', 'hold up amber talisman', 'lift up talisman']);
    // The realm's empty slot is no item, as it is on an `Item: 0` exit.
    expect(
      parseAction('Action [on the N exit of this room]: pull lever (Item: 0)')?.item
    ).toBeUndefined();
    expect(parseAction('Action [on the N exit of this room]: pull lever')?.item).toBeUndefined();
  });

  it('refuses a lever with no phrase behind it', () => {
    expect(parseAction('Action [on the N exit of this room]:')).toBeNull();
    expect(parseAction('Action [on the N exit of this room]:   ')).toBeNull();
  });

  /* Everything else in these columns is a destination or a blank. */
  it('is null for anything that is not a lever', () => {
    expect(parseAction('10/3 (Hidden/Needs 1 Actions, any order)')).toBeNull();
    expect(parseAction('1/1375')).toBeNull();
    expect(parseAction('0')).toBeNull();
    expect(parseAction(null)).toBeNull();
  });
});

/*
 * The other half of the same fact: what the gated exit itself states. The
 * phrases are not in this string — they are in whichever room holds the lever —
 * so `buildRealm` makes the join and this only reads the count and the order.
 */
describe('a hidden exit that needs levers pulled', () => {
  it('reads how many and whether the order matters', () => {
    const any = parseInstruction('Hidden/Needs 1 Actions, any order');
    expect(any?.kind).toBe('hidden');
    expect(any?.searchable).toBe(false);
    expect(any?.actionsNeeded).toBe(1);
    expect(any?.actionsOrdered).toBe(false);

    const ordered = parseInstruction('Hidden/Needs 4 Actions, specific order');
    expect(ordered?.actionsNeeded).toBe(4);
    expect(ordered?.actionsOrdered).toBe(true);
  });

  /* A searchable one needs no levers, and states none. */
  it('leaves the count absent for a searchable exit', () => {
    const found = parseInstruction('Hidden/Searchable');
    expect(found?.searchable).toBe(true);
    expect(found?.actionsNeeded).toBeUndefined();
  });
});

/*
 * The seven kinds todo 03 left classified and unread — todo 00, 2026-09-06.
 *
 * Each shape below is one the survey found in *both* realm databases on this
 * machine, not one invented to exercise a regex: the counts are in
 * `WorldGraph.test.ts`'s shipped-realm survey, and a realm that stops holding
 * them fails there.
 */
describe('the conditions a character is born with or carries', () => {
  it('reads a race gate exactly as it reads a class gate', () => {
    const gate = parseInstruction('Race: 13 OK, 0 NO');
    expect(gate?.kind).toBe('race');
    expect(gate?.raceOk).toBe(13);
    // Zero is the realm's empty slot in both columns. Kept, it would read as
    // *race zero may pass* and shut the exit against everybody.
    expect(gate?.raceNo).toBeUndefined();

    const denied = parseInstruction('Race: 0 OK, 4 NO');
    expect(denied?.raceOk).toBeUndefined();
    expect(denied?.raceNo).toBe(4);
  });

  it('reads a standing window in the realm’s own spelling', () => {
    const temple = parseInstruction('Alignment: Saint to Seedy');
    expect(temple?.kind).toBe('alignment');
    expect(temple?.minAlignment).toBe('Saint');
    expect(temple?.maxAlignment).toBe('Seedy');

    // `Fiend` here, `FIEND` on the roster — one word, two spellings, which is
    // why nothing compares them as strings.
    const pit = parseInstruction('Alignment: Neutral to Fiend');
    expect(pit?.minAlignment).toBe('Neutral');
    expect(pit?.maxAlignment).toBe('FIEND');
  });

  /*
   * Half a window is not a window. A minimum with no maximum would read as
   * *everybody above Saint*, which is the reassuring guess — so a word neither
   * the realm nor the roster names leaves both ends absent and the gate stays
   * unreadable, which the router discourages rather than opens.
   */
  it('leaves both ends absent when it cannot read one of them', () => {
    const odd = parseInstruction('Alignment: Saint to Sinner');
    expect(odd?.kind).toBe('alignment');
    expect(odd?.minAlignment).toBeUndefined();
    expect(odd?.maxAlignment).toBeUndefined();
  });

  it('reads an ability gate, and drops the realm’s empty slot', () => {
    const rune = parseInstruction('Ability: 152 w/value 1 to 1');
    expect(rune?.kind).toBe('ability');
    expect(rune?.abilityId).toBe(152);
    /*
     * The window is the comparison the server makes, in the shape a room
     * script's `checkability` already takes — one field for the realm's two
     * spellings of one gate, so `edgePenalty` answers both by asking once.
     */
    expect(rune?.abilities).toEqual([{ id: 152, atLeast: 1, atMost: 1 }]);
    expect(rune?.raw).toContain('1 to 1');

    const guild = parseInstruction('Ability: 204 w/value 1 to 999');
    expect(guild?.abilities).toEqual([{ id: 204, atLeast: 1, atMost: 999 }]);

    // `Ability: 0` is an exit the server builds plain, so the id is dropped and
    // the price reads the absence as *no gate at all* — and states no gate for
    // the counters to fail either.
    const none = parseInstruction('Ability: 0 w/value 0 to 0');
    expect(none?.kind).toBe('ability');
    expect(none?.abilityId).toBeUndefined();
    expect(none?.abilities).toBeUndefined();
  });

  it('reads both spells a cast exit fires, and neither of the zeroes', () => {
    const scatter = parseInstruction('Cast: pre-0, post-1257');
    expect(scatter?.kind).toBe('cast');
    expect(scatter?.castPre).toBeUndefined();
    expect(scatter?.castPost).toBe(1257);
    // What the spell *does* is the realm's spell table's answer, not this
    // string's — `WorldGraph.resolveSpells` makes that join at load.
    expect(scatter?.spellEffect).toBeUndefined();

    const before = parseInstruction('Cast: pre-681, post-0');
    expect(before?.castPre).toBe(681);
    expect(before?.castPost).toBeUndefined();

    const neither = parseInstruction('Cast: pre-0, post-0');
    expect(neither?.castPre).toBeUndefined();
    expect(neither?.castPost).toBeUndefined();
  });

  it('reads the spell a trapped exit fires', () => {
    const darts = parseInstruction('Spell Trap: 905');
    expect(darts?.kind).toBe('spell');
    expect(darts?.spellId).toBe(905);
  });

  it('reads an item gate into the same field a key gate uses', () => {
    const rope = parseInstruction('Item: 191');
    expect(rope?.kind).toBe('item');
    // One fact — *this exit wants that item in the pack* — so one field, which
    // is what makes the Room card's chip name the rope.
    expect(rope?.keyId).toBe(191);

    const ticket = parseInstruction('Ticket/Item: 924');
    expect(ticket?.kind).toBe('item');
    expect(ticket?.keyId).toBe(924);

    const empty = parseInstruction('Item: 0');
    expect(empty?.kind).toBe('item');
    expect(empty?.keyId).toBeUndefined();
  });

  /*
   * The one shape with a single sample and no clock behind it. Classified and
   * kept verbatim, deliberately not decoded: one exit in the shipped realm
   * writes it, the other database writes none at all, and inventing units from
   * one sample is the guess the rest of this file exists to refuse.
   */
  it('classifies a timed exit and reads no numbers out of it', () => {
    const timed = parseInstruction('Timed: 0*5 minutes');
    expect(timed?.kind).toBe('timed');
    expect(timed?.raw).toBe('Timed: 0*5 minutes');
  });
});
