import { describe, expect, it } from 'vitest';
import type { WorldNames } from '@shared/world';

import { NameIndex, runsOf, type Row } from '../names';

/**
 * A `WorldNames` with only the kinds a test cares about.
 *
 * The realm ships six name kinds and most of these tests are about one of
 * them; spelling all six out per fixture is how a new kind turns into a
 * hundred-line diff that says nothing.
 */
function realm(names: Partial<WorldNames>): NameIndex {
  return new NameIndex({
    items: [],
    mobs: [],
    spells: [],
    races: [],
    classes: [],
    rooms: [],
    ...names
  });
}

const index = realm({
  items: ['quarterstaff', 'padded boots', 'jail key', 'net'],
  mobs: ['giant rat', 'rat', 'sheriff lionheart'],
  spells: ['heal', 'minor healing']
});

describe('finding realm names in a row of console text', () => {
  it('finds a name whole, by column', () => {
    expect(index.find('You are carrying padded boots (Feet), quarterstaff.')).toEqual([
      { name: 'padded boots', kind: 'item', start: 17, end: 29 },
      { name: 'quarterstaff', kind: 'item', start: 38, end: 50 }
    ]);
  });

  /* The longer name is the more specific claim, as with room occupants. */
  it('prefers the longest name at a position', () => {
    expect(index.find('A giant rat bites you!').map((hit) => hit.name)).toEqual(['giant rat']);
  });

  it('does not match part of a word', () => {
    expect(index.find('The rats scatter. Heals all round.')).toEqual([]);
  });

  it('is case-insensitive and keeps the column of what was printed', () => {
    const [hit] = index.find('Also here: Sheriff Lionheart.');
    expect(hit).toEqual({ name: 'sheriff lionheart', kind: 'mob', start: 11, end: 28 });
  });

  /* `net` is an item and a word; underlining every net in prose is noise. */
  it('leaves very short single-word names alone', () => {
    expect(index.find('a net profit')).toEqual([]);
    expect(index.size).toBe(7);
  });
});

/*
 * A name can be folded across two rows: by the server, which breaks some
 * listings at a word and sends a hard break, or by the pane, which wraps a
 * long line at the cell. Read one row at a time, the item that folded was the
 * one item that could not be clicked.
 */
describe('finding a name folded across two rows', () => {
  const broken = (...texts: string[]): Row[] => texts.map((text) => ({ text, continues: false }));

  it('joins the halves of a server fold and places each end on its own row', () => {
    const rows = broken('You are carrying a net, some padded', 'boots (Feet), quarterstaff.');
    expect(index.findAcross(rows)).toEqual([
      {
        name: 'padded boots',
        kind: 'item',
        text: 'padded boots',
        start: { line: 0, col: 29 },
        end: { line: 1, col: 5 }
      },
      {
        name: 'quarterstaff',
        kind: 'item',
        text: 'quarterstaff',
        start: { line: 1, col: 14 },
        end: { line: 1, col: 26 }
      }
    ]);
  });

  /* The pane breaks at the cell, so the fold may fall inside a word or on a space. */
  it('joins a pane wrap with nothing between, keeping the trailing space of the row above', () => {
    const inWord = index.findAcross([
      { text: 'You are carrying a quarter', continues: false },
      { text: 'staff and a jail key.', continues: true }
    ]);
    expect(inWord.map((hit) => [hit.name, hit.start, hit.end])).toEqual([
      ['quarterstaff', { line: 0, col: 19 }, { line: 1, col: 5 }],
      ['jail key', { line: 1, col: 12 }, { line: 1, col: 20 }]
    ]);
    const onSpace = index.findAcross([
      { text: 'You are carrying some padded ', continues: false },
      { text: 'boots.', continues: true }
    ]);
    expect(onSpace.map((hit) => hit.text)).toEqual(['padded boots']);
  });

  it('keeps the printed casing and collapses the fold to one space', () => {
    const [hit] = index.findAcross(broken('Also here: Sheriff', 'Lionheart.'));
    expect(hit?.text).toBe('Sheriff Lionheart');
    expect(hit?.name).toBe('sheriff lionheart');
  });

  /* Punctuation at the fold means the rows were two sentences, not one name. */
  it('does not join across punctuation', () => {
    expect(index.findAcross(broken('You wear something padded.', 'Boots lie here.'))).toEqual([]);
  });

  /*
   * What a row says on its own stands. A straddle that would take a word from
   * a name already found is not offered, so consulting the neighbours can only
   * add a link, never take one away.
   */
  it('lets a name wholly on a row win over a straddle that would eat it', () => {
    const shields = realm({
      items: ['small shield', 'shield of light'],
      mobs: [],
      spells: []
    });
    const hits = shields.findAcross(broken('He hands you a small', 'shield of light and leaves.'));
    expect(hits.map((hit) => hit.name)).toEqual(['shield of light']);
  });

  /* Only the fold marker collapses; padding inside a row is compared verbatim. */
  it('does not bridge column padding within a row', () => {
    expect(index.findAcross(broken('padded          boots'))).toEqual([]);
  });

  it('answers the same as a single-row search when there is no fold', () => {
    const row = 'A giant rat bites you!';
    expect(
      index.findAcross(broken(row)).map((hit) => [hit.name, hit.start.col, hit.end.col])
    ).toEqual(index.find(row).map((hit) => [hit.name, hit.start, hit.end]));
  });
});

describe('the people the console recognises', () => {
  const people = realm({
    items: ['torch'],
    mobs: ['nathaniel', 'giant rat'],
    spells: []
  });
  people.setPlayers(['Nathaniel', 'Soul']);

  it('finds a person by name, as a player', () => {
    expect(people.find('Soul gossips: anyone selling a rope?')).toEqual([
      { name: 'soul', kind: 'player', start: 0, end: 4 }
    ]);
  });

  /* The shipped realm has a monster called nathaniel, and Nathaniel is a
     character on the test realm: the roster wins, as it does everywhere. */
  it('reads a roster name as a player even where the realm has a monster of that name', () => {
    expect(
      people.find('Also here: Nathaniel, giant rat.').map((hit) => [hit.name, hit.kind])
    ).toEqual([
      ['nathaniel', 'player'],
      ['giant rat', 'mob']
    ]);
  });

  /* The same floor the realm's names get: a person called Bo would otherwise
     make every `bo` in prose a link to them. */
  it('leaves a very short name unlinked, as it does for the realm', () => {
    const short = realm({ items: [], mobs: ['orc rogue'], spells: [] });
    short.setPlayers(['Bo', 'Soul']);
    expect(
      short.find('Al says: go with bo and the orc rogue, Soul').map((hit) => [hit.name, hit.kind])
    ).toEqual([
      ['orc rogue', 'mob'],
      ['soul', 'player']
    ]);
  });

  it('is replaced whole, so somebody forgotten is no longer a link', () => {
    people.setPlayers(['Soul']);
    expect(people.find('Also here: Nathaniel.').map((hit) => hit.kind)).toEqual(['mob']);
    expect(people.size).toBe(3);
  });

  /* The registry is the realm's whole record now, offline people included. A
     person who is not in the realm cannot be the one a line is about, so the
     realm's own word wins — and a name the realm has no word for is still a
     person, wherever they are. */
  it('lets an offline person yield to a realm name, and links them where the realm has none', () => {
    const roster = realm({ items: [], mobs: ['lynx', 'nathaniel'], spells: [] });
    roster.setPlayers(['Lynx', 'Nathaniel', 'Soul'], ['Nathaniel']);
    expect(
      roster.find('Also here: Nathaniel, lynx. Soul waves.').map((hit) => [hit.name, hit.kind])
    ).toEqual([
      ['nathaniel', 'player'],
      ['lynx', 'mob'],
      ['soul', 'player']
    ]);
  });
});

describe('a sentence as runs', () => {
  const idx = realm({ items: ['jail key'], mobs: ['orc rogue'], spells: [] });
  idx.setPlayers(['Soul']);

  it('keeps the words around the names, in order, and nothing twice', () => {
    const text = 'Soul is attacking the orc rogue!';
    const runs = runsOf(text, idx.find(text));
    expect(runs.map((run) => run.text)).toEqual(['Soul', ' is attacking the ', 'orc rogue', '!']);
    expect(runs.map((run) => run.hit?.kind ?? null)).toEqual(['player', null, 'mob', null]);
    expect(runs.map((run) => run.text).join('')).toBe(text);
  });

  it('handles names at both ends and two side by side', () => {
    const text = 'orc rogue jail key';
    const runs = runsOf(text, idx.find(text));
    expect(runs.map((run) => [run.text, run.hit?.kind ?? null])).toEqual([
      ['orc rogue', 'mob'],
      [' ', null],
      ['jail key', 'item']
    ]);
  });

  it('is one plain run for a sentence naming nothing, and none for nothing', () => {
    expect(runsOf('Your command had no effect.', [])).toEqual([
      { text: 'Your command had no effect.', hit: null }
    ]);
    expect(runsOf('', [])).toEqual([]);
  });

  it('moves its version when the people change, so a memo over a search can follow', () => {
    const before = idx.version;
    idx.setPlayers(['Soul', 'Rand']);
    expect(idx.version).toBe(before + 1);
  });
});

/*
 * A room's name is the one kind assembled out of ordinary words, so it needs
 * two guards the other kinds do not: a floor that keeps the bare common nouns
 * out, and a word budget wide enough for the long ones.
 */
describe('room names in the console', () => {
  it('recognises a multi-word room name', () => {
    const index = realm({ rooms: ['silver street', 'town square'] });
    expect(index.find('You walk into Silver Street and stop.')).toEqual([
      { name: 'silver street', kind: 'room', start: 14, end: 27 }
    ]);
  });

  /*
   * 66 of the realm's 3,779 names are a single common noun, and `street` alone
   * occurs 289 times in the capture corpus — nearly always inside a longer
   * name. Linked bare it would underline prose and split `Silver Street`.
   */
  it('refuses a one-word room name however long', () => {
    const index = realm({ rooms: ['street', 'junkyard', 'graveyard'] });
    expect(index.find('You cross the street past the junkyard.')).toEqual([]);
  });

  /*
   * `Khazarad, Corner of Gate Wall and Forge Street` is eight words, and 396 of
   * the realm's names are six or more. At the old budget of five, every one of
   * them matched nothing while its first five words matched whatever shorter
   * name sat there.
   */
  it('reaches a name of eight words', () => {
    const long = 'khazarad, corner of gate wall and forge street';
    const index = realm({ rooms: [long] });
    const [hit] = index.find(`Khazarad, Corner of Gate Wall and Forge Street`);
    expect(hit?.name).toBe(long);
    expect(hit?.kind).toBe('room');
  });

  /*
   * Everything else outranks a room: where a name is both, the thing standing
   * in front of you is the better answer.
   */
  it('lets a monster of the same name win', () => {
    const index = realm({ rooms: ['giant rat'], mobs: ['giant rat'] });
    expect(index.find('a giant rat')[0]?.kind).toBe('mob');
  });
});

/*
 * A gang is the other thing a `who` row names, and it was the one recognisable
 * thing on that line that could not be clicked.
 */
describe('the gangs a console recognises', () => {
  const gangs = realm({ items: ['valor shield'], mobs: ['orc rogue'], spells: [] });
  gangs.setGangs(['Valor', 'Rhudaur']);

  it('finds a gang by name', () => {
    expect(gangs.find('Rend         Knight     Neutral   Valor')).toEqual([
      { name: 'valor', kind: 'gang', start: 34, end: 39 }
    ]);
  });

  /*
   * Below the realm's own names, and the tier is the point. A gang name is a
   * word somebody typed when they founded it, so it collides with items and
   * monsters exactly as a player name does — and unlike a player it is not
   * *present*, so it links only where the realm has no word of its own.
   */
  it('yields to a realm name of the same spelling', () => {
    const clash = realm({ items: [], mobs: ['valor'], spells: [] });
    clash.setGangs(['Valor']);
    expect(clash.find('Also here: valor.').map((hit) => hit.kind)).toEqual(['mob']);
  });

  /* A person in the realm outranks everything, gangs included: somebody could
     found a gang named after themselves. */
  it('yields to a person who is in the realm now', () => {
    const both = realm({ items: [], mobs: [], spells: [] });
    both.setGangs(['Valor']);
    both.setPlayers(['Valor'], ['Valor']);
    expect(both.find('Valor gossips: hello').map((hit) => hit.kind)).toEqual(['player']);
  });

  /* The same floor everything else gets: a gang called `Bo` would make every
     `bo` in prose a link. */
  it('leaves a very short gang name unlinked', () => {
    const short = realm({ items: [], mobs: [], spells: [] });
    short.setGangs(['Bo', 'Valor']);
    expect(short.find('bo and Valor').map((hit) => hit.name)).toEqual(['valor']);
  });

  it('is replaced whole, so a gang nobody is in is no longer a link', () => {
    const forgotten = realm({ items: [], mobs: [], spells: [] });
    forgotten.setGangs(['Valor']);
    forgotten.setGangs([]);
    expect(forgotten.find('Valor')).toEqual([]);
  });

  /* A memo over a search keys on this, so it has to move when the gangs do. */
  it('moves its version when the gangs change', () => {
    const versioned = realm({ items: [], mobs: [], spells: [] });
    const before = versioned.version;
    versioned.setGangs(['Valor']);
    expect(versioned.version).toBeGreaterThan(before);
  });
});
