import { describe, expect, it } from 'vitest';

import { UNCATEGORISED, type Loop } from '@shared/loops';

import { groupLoops, LOOP_DESTINATIONS, LOOP_SECTIONS, loopRows, NOWHERE } from '../loops';

/** A shelf loop, named the way every one of MegaMUD's 420 is. */
const loop = (name: string, stops = 2): Loop => ({
  name,
  stops: Array.from({ length: stops }, (_, at) => ({ room: `Room ${at}` })),
  category: name.includes(':') ? name.slice(0, name.indexOf(':')).trim() : UNCATEGORISED
});

describe('the shelf, as rows', () => {
  it('takes the area off the front of a name the heading already states', () => {
    const [row] = loopRows([loop('Ancient Fortress: Hedge Maze-17 2868')], []);
    expect(row?.shortName).toBe('Hedge Maze-17 2868');
  });

  /* A loop with no area has nothing restated above it, so nothing is trimmed
     — and a name is never shortened by guessing where its prefix ends. */
  it('leaves an uncategorised name whole', () => {
    const [row] = loopRows([loop('Sewer circuit')], []);
    expect(row?.shortName).toBe('Sewer circuit');
  });

  /*
   * A file that stated its own category has a name that does not begin with
   * it. Trimming a prefix that is not there would take real characters off the
   * front of a name somebody chose.
   */
  it('does not trim an area that is not actually the prefix', () => {
    const stated: Loop = {
      name: 'Sewer circuit',
      stops: [{ room: 'A' }, { room: 'B' }],
      category: 'Mine'
    };
    const [row] = loopRows([stated], []);
    expect(row?.shortName).toBe('Sewer circuit');
  });

  it('marks the ones this character already walks', () => {
    const rows = loopRows(
      [loop('Sewers: Dark Cave-1 866'), loop('Volcano: Rim-4 12')],
      [{ name: 'Sewers: Dark Cave-1 866', stops: 2 }]
    );
    expect(rows.map((row) => row.held)).toEqual([true, false]);
  });

  /*
   * Somebody's own hand-written loop is the one they will look for here first,
   * and a modal claiming to hold every loop while omitting the ones they wrote
   * is the more confusing of the two mistakes.
   */
  it('keeps a loop the character walks that is not on the shelf', () => {
    const rows = loopRows([loop('Volcano: Rim-4 12')], [{ name: 'Sewer circuit', stops: 5 }]);
    expect(rows.map((row) => row.name)).toEqual(['Volcano: Rim-4 12', 'Sewer circuit']);
    expect(rows[1]?.held).toBe(true);
    expect(rows[1]?.stops).toBe(5);
  });

  /*
   * The bug this shape exists to make impossible.
   *
   * `loop:list` gives a name and a stop *count*, never the stops. The first
   * version filled the gap with `{ room: '' }` placeholders so every row could
   * carry a `Loop` — and `asLoops` drops an empty room, so the loop parsed to
   * nothing and main refused the player's own hand-written loop as one "the
   * client cannot file". Absence stood in as a value and came back as a false
   * claim about their data. A held-only row carries a *name* now, and is
   * started through the channel that resolves one.
   */
  it('asks for a held-only loop by name, never as a loop with invented stops', () => {
    const [row] = loopRows([], [{ name: 'Sewer circuit', stops: 4 }]);
    expect(row?.choice).toEqual({ kind: 'by-name', name: 'Sewer circuit', stops: 4 });
  });

  /* A shelf row does carry the loop, because filing it means writing its
     stops — the other half of the same distinction. */
  it('asks for a shelf loop as the loop itself, because filing it needs its stops', () => {
    const [row] = loopRows([loop('Volcano: Rim-4 12', 3)], []);
    expect(row?.choice.kind).toBe('loop');
    expect(row?.choice).toMatchObject({ kind: 'loop', loop: { name: 'Volcano: Rim-4 12' } });
  });

  /* Held *and* on the shelf is a shelf row: the catalogue has the real stops,
     so it can be filed into another scope. */
  it('prefers the shelf entry when the character already walks a shipped loop', () => {
    const [row] = loopRows(
      [loop('Sewers: Dark Cave-1 866')],
      [{ name: 'Sewers: Dark Cave-1 866', stops: 2 }]
    );
    expect(row?.choice.kind).toBe('loop');
    expect(row?.held).toBe(true);
  });

  /* A name is how a loop is addressed everywhere in this client, so one that
     appears on the shelf and in the character's own list is one loop. */
  it('merges by name rather than offering the same loop twice', () => {
    const rows = loopRows(
      [loop('Sewers: Dark Cave-1 866')],
      [{ name: 'sewers: dark cave-1 866', stops: 2 }]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.held).toBe(true);
  });

  /*
   * The key is where a row is, never what it is named: the realm's own data
   * repeats names, and a key that moved when the list was filtered would be
   * React reconciling two different rows into one.
   */
  it('keys a row by its place, not by its name', () => {
    const rows = loopRows([loop('A: one'), loop('B: two')], []);
    expect(rows.map((row) => row.key)).toEqual(['0', '1']);
  });
});

describe('grouping and searching the shelf', () => {
  const shelf = [
    loop('Ancient Fortress: Hedge Maze-17 2868'),
    loop('Ancient Fortress: Burning Plains-17 9507'),
    loop('Sewers: Dark Cave-1 866'),
    loop('Sewer circuit')
  ];

  it('gathers the rows under their areas, in the order they first appear', () => {
    const groups = groupLoops(loopRows(shelf, []), '');
    expect(groups.map((group) => group.category)).toEqual([
      'Ancient Fortress',
      'Sewers',
      UNCATEGORISED
    ]);
    expect(groups[0]?.loops).toHaveLength(2);
  });

  /* The names are `Area: Room-map room`, so `sewer dark` and `dark sewer` are
     the same question — every term, from anywhere in the row. */
  it('takes every term, in any order', () => {
    const forward = groupLoops(loopRows(shelf, []), 'sewers dark');
    const backward = groupLoops(loopRows(shelf, []), 'dark sewers');
    expect(forward).toEqual(backward);
    expect(forward.flatMap((group) => group.loops)).toHaveLength(1);
  });

  /* The area is searched as well as the name, so typing an area still finds a
     row whose own displayed name has had that area trimmed out of it. */
  it('finds a row by the area above it', () => {
    const groups = groupLoops(loopRows(shelf, []), 'fortress');
    expect(groups.map((group) => group.category)).toEqual(['Ancient Fortress']);
    expect(groups[0]?.loops).toHaveLength(2);
  });

  /*
   * An open heading over no rows says that area was searched and found
   * wanting, which is a claim about every other area the reader then has to
   * scroll past to disprove.
   */
  it('drops a group with nothing left in it rather than drawing it empty', () => {
    const groups = groupLoops(loopRows(shelf, []), 'hedge');
    expect(groups).toHaveLength(1);
    expect(groups[0]?.loops).toHaveLength(1);
  });

  it('finds nothing rather than everything for a query that matches none', () => {
    expect(groupLoops(loopRows(shelf, []), 'nowhere at all')).toEqual([]);
  });

  /* Whitespace is not a term: a trailing space while typing must not empty
     the list somebody is reading. */
  it('treats a blank query as no query', () => {
    expect(groupLoops(loopRows(shelf, []), '   ')).toEqual(groupLoops(loopRows(shelf, []), ''));
  });
});

describe('where a chosen loop is kept', () => {
  /*
   * The runtime half of the union, which this project requires to move with
   * the type: a destination in the type and not in this list draws no chip,
   * which is a control that cannot be chosen and no error saying so.
   */
  it('offers the character, the realm and an explicit refusal, in that order', () => {
    expect(LOOP_DESTINATIONS).toEqual(['profile', 'server', 'none']);
  });

  /*
   * `global` writes into every character on the client at once. That is a
   * decision to open the settings screen for, not one to make in passing from
   * a modal one keystroke away.
   */
  it('does not offer to write into every character at once', () => {
    expect(LOOP_DESTINATIONS).not.toContain('global');
  });
});

describe('the sections above the areas', () => {
  /** A shelf loop whose stops are named outright, rather than `Room 0`. */
  const at = (name: string, ...rooms: string[]): Loop => ({
    name,
    stops: rooms.map((room) => ({ room })),
    category: name.includes(':') ? name.slice(0, name.indexOf(':')).trim() : UNCATEGORISED
  });

  const shelf = [
    at('Sewers: Dark Cave-1 866', 'Newhaven, Arena', 'Sewer Mouth'),
    at('Volcano: Rim-4 12', 'Rim East', 'Newhaven, Arena', 'Rim West'),
    at('Ancient Fortress: Hedge Maze-17 2868', 'Hedge Gate', 'Hedge Centre')
  ];
  const rows = loopRows(shelf, []);
  const inArena = { ...NOWHERE, roomName: 'Newhaven, Arena' };

  /* The runtime half of the union beside the type, as this project requires:
     a section in the type and not in this list is one that never appears. */
  it('draws the recent loop, then what starts here, then what passes through', () => {
    expect(LOOP_SECTIONS).toEqual(['recent', 'start', 'waypoint']);
  });

  it('hoists the loop that begins in this room above the areas', () => {
    const groups = groupLoops(rows, '', inArena);
    expect(groups[0]?.section).toBe('start');
    expect(groups[0]?.loops.map((row) => row.name)).toEqual(['Sewers: Dark Cave-1 866']);
  });

  /* Starting here and merely passing through are the difference the sections
     exist for: one can be started with no walk at all, the other cannot. */
  it('keeps a loop that only passes through in its own section, below start', () => {
    const groups = groupLoops(rows, '', inArena);
    expect(groups.map((group) => group.section)).toEqual(['start', 'waypoint', 'area']);
    expect(groups[1]?.loops.map((row) => row.name)).toEqual(['Volcano: Rim-4 12']);
  });

  it('puts the loop this character last walked above both', () => {
    const groups = groupLoops(rows, '', { ...inArena, recent: 'Volcano: Rim-4 12' });
    expect(groups[0]?.section).toBe('recent');
    expect(groups[0]?.loops.map((row) => row.name)).toEqual(['Volcano: Rim-4 12']);
  });

  /* The palette's own pin rule: a hoisted row is moved, never copied. Two rows
     for one loop is two things to compare with nothing to tell them apart. */
  it('draws a hoisted loop once, out of its area rather than as well as', () => {
    const groups = groupLoops(rows, '', { ...inArena, recent: 'Sewers: Dark Cave-1 866' });
    const names = groups.flatMap((group) => group.loops.map((row) => row.name));
    expect(names.filter((name) => name === 'Sewers: Dark Cave-1 866')).toHaveLength(1);
    expect(groups.find((group) => group.category === 'Sewers')).toBeUndefined();
  });

  /* A loop that both starts here and was last walked takes the first section
     it qualifies for, for the same reason. */
  it('takes only the first section a loop qualifies for', () => {
    const groups = groupLoops(rows, '', { ...inArena, recent: 'Sewers: Dark Cave-1 866' });
    expect(groups.map((group) => group.section)).toEqual(['recent', 'waypoint', 'area']);
  });

  /*
   * `Starts here` over no rows is the client answering a question nobody
   * asked, in most rooms, for ever — deliberately unlike an area heading,
   * which is a map of what the realm holds and is worth a row when shut.
   */
  it('draws no section for a room with nothing in it', () => {
    const groups = groupLoops(rows, '', { ...NOWHERE, roomName: 'Somewhere Else' });
    expect(groups.every((group) => group.section === 'area')).toBe(true);
  });

  /*
   * "I do not know where you are" must never come out as "every loop starts
   * here". An unplaced character gets the areas and nothing else.
   */
  it('hoists nothing at all when the client has not placed the character', () => {
    expect(groupLoops(rows, '', NOWHERE)).toEqual(groupLoops(rows, ''));
  });

  /*
   * `Town Gates 1/2150` names one of thirteen rooms called Town Gates.
   * Matching the other twelve on the name they share would hoist a loop that
   * begins somewhere the character is not.
   */
  it('settles a stop that states coordinates on the coordinates alone', () => {
    const gates = loopRows([at('Gates: circuit', 'Town Gates 1/2150', 'Elsewhere')], []);
    const wrongRoom = { ...NOWHERE, roomName: 'Town Gates', at: { map: 1, room: 9999 } };
    expect(groupLoops(gates, '', wrongRoom).every((group) => group.section === 'area')).toBe(true);
    const rightRoom = { ...NOWHERE, roomName: 'Town Gates', at: { map: 1, room: 2150 } };
    expect(groupLoops(gates, '', rightRoom)[0]?.section).toBe('start');
  });

  /*
   * `loop:list` answers with a name and a stop *count*, so a held-only loop's
   * places are genuinely unknown. Claiming a route the client has not read is
   * the failure `LoopChoice`'s two shapes already exist to have stopped.
   */
  it('never hoists a held-only loop, whose stops it has not been told', () => {
    const held = loopRows([], [{ name: 'Sewer circuit', stops: 4 }]);
    expect(groupLoops(held, '', inArena).every((group) => group.section === 'area')).toBe(true);
  });

  /* A held-only loop is still the one somebody is most likely to want back,
     and the recent section needs no stops to name it. */
  it('still hoists a held-only loop as the recent one', () => {
    const held = loopRows([], [{ name: 'Sewer circuit', stops: 4 }]);
    const groups = groupLoops(held, '', { ...NOWHERE, recent: 'sewer circuit' });
    expect(groups[0]?.section).toBe('recent');
  });

  /* The id is what the modal remembers as open, and a section's *label* is a
     sentence about the room that changes as the character walks. */
  it('gives every group a stable id that no area name can collide with', () => {
    const groups = groupLoops(rows, '', inArena);
    expect(groups.map((group) => group.id)).toEqual(['!start', '!waypoint', 'Ancient Fortress']);
  });

  /* A section is not a way round the query: a search still narrows it. */
  it('narrows a section by the query like any other group', () => {
    const groups = groupLoops(rows, 'volcano', inArena);
    expect(groups.map((group) => group.section)).toEqual(['waypoint']);
  });
});
