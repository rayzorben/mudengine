import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { WorldGraph } from '../../world/WorldGraph';
import type { FightRecord, FightSink } from '../../../shared/fights';
import { CharacterTracker, parseExit } from '../CharacterTracker';
import { Classifier } from '../Classifier';
import type { StreamLine } from '../../../shared/types';
import {
  learn,
  learnSlot,
  loreMaximum,
  NO_LORE,
  type MobLore,
  type MobLoreEntry,
  type SlotLoreEntry
} from '../../../shared/lore';
import type { Discovery } from '../../../shared/memory';
import type { RoomOccupant } from '../../../shared/character';
import type { PlayerFacts, RealmPlayers } from '../../../shared/players';
import { NO_BELONGINGS } from '../../../shared/belongings';
import { DEFAULT_INTERNAL } from '../../../shared/internal';

const TUNING = DEFAULT_INTERNAL.tuning;

/**
 * Feeds plain lines through the real classifier into the tracker.
 *
 * A string is a line the server sent; `{ send }` is a command the client sent,
 * which is how the tracker learns a direction was attempted. Both go through
 * the real classifier, because what a line *is* depends on the command before
 * it.
 */
type Step = string | { send: string };

/**
 * The names off a room's occupant list.
 *
 * Most of these assertions are about *who is in the room*, which is still a
 * list of names; what each one turned out to be is asserted where the
 * classification itself is tested.
 */
function names(occupants: readonly RoomOccupant[]): string[] {
  return occupants.map((who) => who.name);
}

function play(
  steps: Step[],
  world?: WorldGraph,
  lore?: MobLore,
  fights?: FightSink,
  players?: RealmPlayers
): CharacterTracker {
  const tracker = new CharacterTracker(world, lore, undefined, fights, players);
  /*
   * Wired the way `SessionManager` wires it, and that matters here rather than
   * being ceremony: a combat line carries the monster's name inside a run of
   * realm-supplied words, and only the room and the realm's monster table can
   * say where it ends. A classifier built without them classifies the line and
   * names nothing, which is not what the client does.
   */
  const classifier = new Classifier({
    present: () => tracker.current.room.occupants.map((who) => who.name),
    mob: (name) => world?.mob(name)
  });
  let seq = 0;
  for (const step of steps) {
    if (typeof step !== 'string') {
      tracker.observeCommand(step.send);
      classifier.observeCommand(step.send);
      continue;
    }
    const plain = step;
    seq += 1;
    const line: StreamLine = {
      seq,
      at: 1_700_000_000_000 + seq,
      text: plain,
      plain,
      terminator: 'newline'
    };
    const { block, batch } = classifier.classify(line);
    tracker.apply(block);
    // Rows and all, exactly as `SessionManager` does it: an array batch that
    // arrives without its rows is a block the tracker cannot read, and a helper
    // that drops them tests something the client never does.
    if (batch) tracker.apply(batch, batch.rows);
  }
  return tracker;
}

describe('session phase', () => {
  it('starts knowing nothing', () => {
    expect(play([]).current.phase).toBe('unknown');
  });

  it('moves to authenticating on a login prompt', () => {
    expect(play(['Please enter your username or "new": ']).current.phase).toBe('authenticating');
  });

  it('moves to in-game on the first status line, and only then', () => {
    // The status line is the discriminator; a menu prompt is not evidence of
    // being in the realm, and neither is a room description.
    const before = play(['[PARADIGM]: ', 'Newhaven, Village Entrance']);
    expect(before.current.phase).toBe('authenticating');

    const after = play(['[PARADIGM]: ', '[HP=31]: ']);
    expect(after.current.phase).toBe('in-game');
  });

  it('does not fall back to authenticating on a menu prompt seen in-game', () => {
    // Game text can quote a menu; losing in-game state over it would blank the
    // HUD mid-fight.
    const tracker = play(['[HP=31]: ', '[PARADIGM]: ']);
    expect(tracker.current.phase).toBe('in-game');
  });

  it('picks the character name out of the welcome line', () => {
    expect(play(['Welcome back, soul!']).current.name).toBe('soul');
  });
});

describe('vitals', () => {
  it('reads hp and mana from the status line', () => {
    const v = play(['[HP=100/MA=50]: ']).current.vitals;
    expect(v.hp).toBe(100);
    expect(v.mana).toBe(50);
    expect(v.manaType).toBe('MA');
  });

  it('leaves mana null for a class that has none', () => {
    // Not zero. A warrior has no mana bar at all, and showing 0/0 is a lie the
    // HUD would then have to render.
    const v = play(['[HP=31]: ']).current.vitals;
    expect(v.hp).toBe(31);
    expect(v.mana).toBeNull();
    expect(v.manaMax).toBeNull();
  });

  it('tracks resting and meditating', () => {
    expect(play(['[HP=50 (Resting) ]: ']).current.vitals.resting).toBe(true);
    expect(play(['[HP=50]: (Meditating)']).current.vitals.meditating).toBe(true);
    expect(play(['[HP=50]: ']).current.vitals.resting).toBe(false);
  });

  it('takes maxima from the stat sheet, which the status line never carries', () => {
    const tracker = play([
      'Name:   Rayzor              Lives/CP: 3/12',
      'Race:   Human      Exp:      1500   Perception:  20',
      'Class:  Warrior    Level:    4      Stealth:     10',
      'Hits:   58/72      Armour Class: 12/3   Thievery:    5',
      '[HP=58]: '
    ]);
    expect(tracker.current.vitals.hpMax).toBe(72);
    expect(tracker.current.className).toBe('Warrior');
    expect(tracker.current.race).toBe('Human');
    expect(tracker.current.progress.level).toBe(4);
  });
});

describe('room assembly', () => {
  const room = [
    'Newhaven, Village Entrance',
    '    Welcome to Newhaven! You are standing at the crude wooden gates.',
    'You notice newbie manual here.',
    'Also here: Nathaniel.',
    'Obvious exits: north, south, west, southeast'
  ];

  it('assembles a room and completes it on the exits line', () => {
    const r = play(room).current.room;
    expect(r.name).toBe('Newhaven, Village Entrance');
    expect(r.exits.map((e) => e.direction)).toEqual(['n', 's', 'w', 'se']);
    expect(names(r.occupants)).toEqual(['Nathaniel']);
    expect(r.items.map((item) => item.name)).toEqual(['newbie manual']);
  });

  it('publishes nothing until exits arrive', () => {
    // Exits complete a room; everything before is a draft. A half-room on the
    // HUD is worse than the previous one.
    expect(play(room.slice(0, 4)).current.room.name).toBeNull();
  });

  it('does not leak a fragment of one room into the next', () => {
    // The failure mode in megamind-client's roomHandler: mutable fields carried
    // across, so a missed line put the wrong occupants in the new room.
    const tracker = play([...room, 'Newhaven, Weapons Shop', 'Obvious exits: south']);
    expect(tracker.current.room.name).toBe('Newhaven, Weapons Shop');
    expect(tracker.current.room.exits.map((e) => e.direction)).toEqual(['s']);
    expect(tracker.current.room.occupants).toEqual([]);
    expect(tracker.current.room.items).toEqual([]);
  });

  it('applies reported coordinates to the room they describe', () => {
    const tracker = play(['Location:   5,1201']);
    expect(tracker.current.room.map).toBe(5);
    expect(tracker.current.room.number).toBe(1201);
  });

  it('clears stale coordinates when a new room arrives', () => {
    // `Location: 5,1201` describes where you were. Carrying it into the next
    // room is a confidently wrong location, which sends the pathfinder
    // somewhere else entirely. Without a world graph to re-resolve against,
    // unknown is the honest answer.
    const tracker = play(['Location:   5,1201', ...room]);
    expect(tracker.current.room.name).toBe('Newhaven, Village Entrance');
    expect(tracker.current.room.map).toBeNull();
    expect(tracker.current.room.resolvedBy).toBeNull();
  });

  it('splits an occupant list on both commas and "and"', () => {
    const tracker = play(['Also here: Nathaniel, Masta and Rayzor.', 'Obvious exits: north']);
    expect(names(tracker.current.room.occupants)).toEqual(['Nathaniel', 'Masta', 'Rayzor']);
  });
});

describe('exit parsing', () => {
  it('reads a plain direction as its canonical short code', () => {
    // One representation everywhere: the realm database uses short codes, and
    // holding two is what let exit-signature resolution silently never match.
    expect(parseExit('north')).toEqual({ direction: 'n', note: null });
    expect(parseExit('n')).toEqual({ direction: 'n', note: null });
  });

  it('separates an obstacle from its direction', () => {
    // A real capture from the local server: `Obvious exits: north, east,
    // closed gate west`. Splitting naively leaves an "exit" that is not a
    // direction and cannot be pathed on.
    expect(parseExit('closed gate west')).toEqual({ direction: 'w', note: 'closed gate' });
  });

  it('prefers the longer compass direction', () => {
    expect(parseExit('northeast').direction).toBe('ne');
    expect(parseExit('door northwest')).toEqual({ direction: 'nw', note: 'door' });
  });

  it('keeps an unrecognised exit rather than dropping it', () => {
    // Silently losing an exit strands a route; keeping it lets phase 4 report
    // that it could not understand one.
    expect(parseExit('gate')).toEqual({ direction: 'gate', note: null });
  });

  it('parses a real mixed exits line end to end', () => {
    const tracker = play(['Bank of Godfrey', 'Obvious exits: north, east, closed gate west']);
    // The wire's own halves. With no realm loaded there is nowhere for them
    // to lead, and a null destination is the honest answer rather than a guess.
    expect(tracker.current.room.exits.map((exit) => [exit.direction, exit.note])).toEqual([
      ['n', null],
      ['e', null],
      ['w', 'closed gate']
    ]);
  });
});

describe('progress and combat', () => {
  it('accumulates session experience', () => {
    const tracker = play(['You gain 40 experience.', 'You gain 2 experience.']);
    expect(tracker.current.progress.expThisSession).toBe(42);
  });

  it('leaves total experience unknown until the game states it', () => {
    // Adding a gain to an unknown total would invent a number.
    expect(play(['You gain 40 experience.']).current.progress.exp).toBeNull();
  });

  it('advances a known total and counts down what is needed', () => {
    const tracker = play([
      'Exp: 1500 Level: 4 Exp needed for next level: 500 (2000) [75%]',
      'You gain 100 experience.'
    ]);
    expect(tracker.current.progress.exp).toBe(1600);
    expect(tracker.current.progress.expNeeded).toBe(400);
  });

  it('tracks combat state', () => {
    expect(play(['*Combat Engaged*']).current.inCombat).toBe(true);
    expect(play(['*Combat Engaged*', '*Combat Off*']).current.inCombat).toBe(false);
  });

  it('does not put realm-wide arrivals in the room', () => {
    // "just entered the Realm" is a global announcement, not room occupancy.
    const tracker = play(['Obvious exits: north', 'Masta just entered the Realm.']);
    expect(tracker.current.room.occupants).toEqual([]);
  });
});

describe('change reporting', () => {
  it('reports no change for a line that says nothing new', () => {
    // The caller republishes state only when this returns true; during a combat
    // burst most lines are prose.
    const classifier = new Classifier();
    const tracker = new CharacterTracker();
    const line = {
      seq: 1,
      at: 1,
      text: 'The torch gutters.',
      plain: 'The torch gutters.',
      terminator: 'newline' as const
    };
    expect(tracker.apply(classifier.classify(line).block)).toBe(false);
  });

  it('forgets everything on reset', () => {
    const tracker = play(['[HP=31]: ', 'Obvious exits: north']);
    tracker.reset();
    expect(tracker.current.phase).toBe('unknown');
    expect(tracker.current.vitals.hp).toBeNull();
    expect(tracker.current.room.exits).toEqual([]);
  });
});

describe('locating the character in the world', () => {
  const file = path.resolve('resources/world/rooms.jsonl.gz');
  const available = fs.existsSync(file);
  const world = available ? WorldGraph.load(file) : null;

  /** Same as `play`, but with a world graph and observed commands. */
  function walk(script: Array<string | { send: string }>): CharacterTracker {
    const classifier = new Classifier();
    const tracker = new CharacterTracker(world ?? undefined);
    let seq = 0;
    for (const entry of script) {
      if (typeof entry === 'object') {
        tracker.observeCommand(entry.send);
        continue;
      }
      seq += 1;
      const line: StreamLine = {
        seq,
        at: 1_700_000_000_000 + seq,
        text: entry,
        plain: entry,
        terminator: 'newline'
      };
      const { block, batch } = classifier.classify(line);
      tracker.apply(block);
      if (batch) tracker.apply(batch);
    }
    return tracker;
  }

  it.runIf(available)('resolves a uniquely named room to its coordinates', () => {
    // Exactly what the live server showed: Bank of Godfrey, north/east/west.
    const tracker = walk(['Bank of Godfrey', 'Obvious exits: north, east, closed gate west']);
    expect(tracker.current.room.map).toBe(1);
    expect(tracker.current.room.number).toBe(297);
    expect(tracker.current.room.resolvedBy).toBe('unique-name');
  });

  it.runIf(available)('follows a movement command into the next room', () => {
    const bank = world!.get(1, 297)!;
    const north = bank.exits.find((e) => e.direction === 'n')!;
    const next = world!.get(north.map, north.room)!;

    const tracker = walk([
      'Bank of Godfrey',
      'Obvious exits: north, east, closed gate west',
      { send: 'n' },
      next.name,
      `Obvious exits: ${next.exits.map((e) => e.direction).join(', ')}`
    ]);

    expect(tracker.current.room.number).toBe(next.room);
    expect(tracker.current.room.resolvedBy).toBe('movement');
    expect(tracker.current.room.confidence).toBeGreaterThan(0.9);
  });

  it.runIf(available)('reports ambiguity rather than guessing', () => {
    // Many rooms share a name; picking one would be confidently wrong.
    const tracker = walk(['Mossy Tunnel', 'Obvious exits: north']);
    if (tracker.current.room.map === null) {
      expect(tracker.current.room.ambiguous).toBeGreaterThan(0);
      expect(tracker.current.room.confidence).toBeLessThan(1);
    }
  });

  it.runIf(available)('leaves an unknown room unlocated', () => {
    const tracker = walk(['Some Room That Does Not Exist', 'Obvious exits: north']);
    expect(tracker.current.room.name).toBe('Some Room That Does Not Exist');
    expect(tracker.current.room.map).toBeNull();
    expect(tracker.current.room.resolvedBy).toBeNull();
  });
});

describe('room description', () => {
  /** The real paragraph the local server prints for the Adventurer's Guild. */
  const guild = [
    "Newhaven, Adventurer's Guild",
    '    This nicely crafted room is well furnished and decorated with things that',
    'you have never seen before, from strange exotic weapons, to swirling vials of',
    'liquid.',
    'Also here: Corwyn.',
    'Obvious exits: south'
  ];

  it('collects the prose between the name and the exits', () => {
    const room = play(guild).current.room;
    expect(room.description).toMatch(/^This nicely crafted room/);
    expect(room.description).toMatch(/swirling vials of liquid\.$/);
  });

  it('does not put the description in the room until the room is complete', () => {
    // Half a paragraph is not a fact about anywhere.
    const partial = play(guild.slice(0, 4)).current.room;
    expect(partial.description).toBeNull();
  });

  it('is null when the server sends none', () => {
    const room = play(["Newhaven, Adventurer's Guild", 'Obvious exits: south']).current.room;
    expect(room.description).toBeNull();
  });

  it('discards a draft description when a new room starts', () => {
    // The failure mode of `megamind-client`'s mutable accumulator: fragments of
    // one room leaking into the next.
    const room = play([
      'Newhaven, Narrow Road',
      '    A dusty path leads away.',
      "Newhaven, Adventurer's Guild",
      '    This nicely crafted room is well furnished.',
      'Obvious exits: south'
    ]).current.room;
    expect(room.name).toBe("Newhaven, Adventurer's Guild");
    expect(room.description).toBe('This nicely crafted room is well furnished.');
  });

  it('does not sweep up unrecognised output when no room is open', () => {
    const state = play(['Something the parser has never seen.']).current;
    expect(state.room.description).toBeNull();
  });
});

describe('the health command', () => {
  it('learns a maximum from the one line that carries both numbers', () => {
    // The status line has no maximum and the stat sheet costs a whole screen.
    const vitals = play(['Health:   33/33   [100%]']).current.vitals;
    expect(vitals.hp).toBe(33);
    expect(vitals.hpMax).toBe(33);
  });
});

describe('the experience table', () => {
  /*
   * A realm that names two races and two classes and nothing else. `exp`'s
   * table is the base progression scaled by the pair, so this is the whole of
   * what the derivation needs from a realm — and it is the shipped realm's own
   * numbers for a Kang Paladin, whose table this client has recorded off the
   * wire (`src/shared/experience.ts`).
   */
  function realmWithClasses(): WorldGraph {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-exp-'));
    const file = path.join(dir, 'rooms.jsonl.gz');
    const header = JSON.stringify({
      v: 10,
      source: 'test',
      rooms: 0,
      generatedAt: 'x',
      races: [
        { id: 11, n: 'Kang', expTable: 150 },
        { id: 13, n: 'Gaunt One', expTable: 120 }
      ],
      classes: [
        { id: 3, n: 'Paladin', expTable: 490 },
        { id: 15, n: 'Mystic', expTable: 420 }
      ]
    });
    fs.writeFileSync(file, zlib.gzipSync(header + '\n'));
    const graph = WorldGraph.load(file);
    fs.rmSync(dir, { recursive: true, force: true });
    return graph;
  }

  /** The listing, verbatim off the wire — a Kang Paladin at level 3. */
  const LISTING = [
    'The following is a table of experience for your character:',
    '',
    'Level   Experience',
    '-----   ----------',
    '   2     7400',
    '   3     14800',
    '   4     27133',
    '   5     49743',
    '   6     85273',
    '   7     146182',
    '   8     237545',
    '   9     386010',
    '  10     600460',
    '  11     934048',
    '[HP=56/MA=12]: '
  ];

  it('keeps every row the realm printed', () => {
    const table = play(['[HP=56/MA=12]: ', ...LISTING]).current.progress.expTable;
    expect(table?.rows).toHaveLength(10);
    expect(table?.rows.every((row) => row.source === 'realm')).toBe(true);
    expect(table?.rows.at(-1)).toEqual({ level: 11, experience: 934048, source: 'realm' });
  });

  it('takes the one row the summary line states, which was being discarded', () => {
    /*
     * `Exp: 75547 Level: 3 Exp needed for next level: 0 (27133) [278%]` — the
     * parenthesised figure is the price of level 4, and the pattern has
     * captured it since it was written without anything reading it.
     */
    const tracker = play([
      '[HP=56/MA=12]: ',
      'Exp: 75547 Level: 3 Exp needed for next level: 0 (27133) [278%]'
    ]);
    expect(tracker.current.progress.expTable?.rows).toEqual([
      { level: 4, experience: 27133, source: 'realm' }
    ]);
  });

  it('works the table out from the realm data before anything has been asked', () => {
    // The point of the derivation: a character that has just logged in and read
    // its stat sheet already knows what the next nine levels cost.
    const tracker = play(
      [
        '[HP=56/MA=12]: ',
        'Name: Festus Marcus                    Lives/CP:      9/2',
        'Race: Kang        Exp: 60410           Perception:     57',
        'Class: Paladin    Level: 3             Stealth:         0',
        'Hits:    56/56    Armour Class:  40/5  Thievery:        0',
        '[HP=56/MA=12]: '
      ],
      realmWithClasses()
    );
    const table = tracker.current.progress.expTable;
    expect(table?.rows.map((row) => row.experience)).toEqual([
      7400, 14800, 27133, 49743, 85273, 146182, 237545, 386010, 600460, 934048
    ]);
    expect(table?.rows.every((row) => row.source === 'database')).toBe(true);
  });

  it('says nothing at all for a race the realm data does not name', () => {
    // Not the base rate: a missing term is not a zero one, and a plausible
    // wrong number here is worse than a card that says it does not know.
    const tracker = play(
      [
        '[HP=57/KAI=9]: ',
        'Name: Someone Else                     Lives/CP:      3/0',
        'Race: Nekojin     Exp: 100             Perception:     10',
        'Class: Mystic     Level: 2             Stealth:         0',
        '[HP=57/KAI=9]: '
      ],
      realmWithClasses()
    );
    expect(tracker.current.progress.expTable).toBeNull();
  });

  it('fills in around the one row GreaterMUD ever states', () => {
    /*
     * The realm this client now ships as its default answers `exp` with the
     * summary line and **no table** — nought tables across every recorded
     * `orohost` session. So the wire states one row and the derivation has to
     * supply the other nine; a client that stopped deriving the moment any row
     * was the realm's showed a chart of one.
     */
    const tracker = play(
      [
        '[HP=56/MA=12]: ',
        'Name: Festus Marcus                    Lives/CP:      9/2',
        'Race: Kang        Exp: 60410           Perception:     57',
        'Class: Paladin    Level: 3             Stealth:         0',
        '[HP=56/MA=12]: ',
        'Exp: 60410 Level: 3 Exp needed for next level: 0 (27133) [222%]',
        '[HP=56/MA=12]: '
      ],
      realmWithClasses()
    );
    const table = tracker.current.progress.expTable;
    expect(table?.rows).toHaveLength(10);
    expect(table?.rows.find((row) => row.level === 4)?.source).toBe('realm');
    expect(table?.rows.filter((row) => row.source === 'database')).toHaveLength(9);
  });

  it('adds nothing more once the realm has contradicted the derivation', () => {
    // A realm whose own data this client does not have — `orohost` prices two
    // of its classes differently from every database on disk. The wire wins,
    // and it goes on winning: the row that refused the chain refuses it again.
    const tracker = play(
      [
        '[HP=56/MA=12]: ',
        'Name: Festus Marcus                    Lives/CP:      9/2',
        'Race: Kang        Exp: 60410           Perception:     57',
        'Class: Paladin    Level: 3             Stealth:         0',
        '[HP=56/MA=12]: ',
        'Exp: 60410 Level: 3 Exp needed for next level: 1 (99999) [1%]',
        '[HP=56/MA=12]: ',
        'Name: Festus Marcus                    Lives/CP:      9/3',
        'Race: Kang        Exp: 60411           Perception:     57',
        'Class: Paladin    Level: 3             Stealth:         0',
        '[HP=56/MA=12]: '
      ],
      realmWithClasses()
    );
    expect(tracker.current.progress.expTable?.rows).toEqual([
      { level: 4, experience: 99999, source: 'realm' }
    ]);
  });

  it('stops deriving once the realm has spoken', () => {
    /*
     * The wire wins, and it goes on winning: a stat sheet arriving after the
     * listing must not put nine worked-out rows back over ten the server sent.
     */
    const tracker = play(
      [
        '[HP=56/MA=12]: ',
        ...LISTING,
        'Name: Festus Marcus                    Lives/CP:      9/2',
        'Race: Kang        Exp: 60410           Perception:     57',
        'Class: Paladin    Level: 3             Stealth:         0',
        '[HP=56/MA=12]: '
      ],
      realmWithClasses()
    );
    const table = tracker.current.progress.expTable;
    // Ten rows, all of them the realm's: the derived window is the same ten
    // levels, so it has nothing to add and adds nothing.
    expect(table?.rows).toHaveLength(10);
    expect(table?.rows.every((row) => row.source === 'realm')).toBe(true);
  });
});

describe('a second look at the same room', () => {
  /*
   * Re-deriving the location on every room block *loses* information: the
   * ladder can only return what a name and an exit list support, so certainty
   * from `pro` decays into inference the moment the player types `l`.
   *
   * These need a world to resolve against, so they build a two-room one rather
   * than depending on the shipped realm data.
   */
  const GUILD = { m: 1, r: 2147, n: "Newhaven, Adventurer's Guild", x: { s: { m: 1, r: 2146 } } };
  const ROAD = { m: 1, r: 2146, n: 'Newhaven, Narrow Road', x: { n: { m: 1, r: 2147 } } };

  function world(): WorldGraph {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-tracker-'));
    const file = path.join(dir, 'rooms.jsonl.gz');
    const header = JSON.stringify({ v: 1, source: 'test', rooms: 2, generatedAt: 'x' });
    fs.writeFileSync(
      file,
      zlib.gzipSync([header, JSON.stringify(GUILD), JSON.stringify(ROAD)].join('\n') + '\n')
    );
    const graph = WorldGraph.load(file);
    fs.rmSync(dir, { recursive: true, force: true });
    return graph;
  }

  /** A tracker that can resolve, plus a way to keep feeding it. */
  function session(): { tracker: CharacterTracker; feed: (lines: string[]) => void } {
    const classifier = new Classifier();
    const tracker = new CharacterTracker(world());
    let seq = 0;
    const feed = (lines: string[]): void => {
      for (const plain of lines) {
        seq += 1;
        const line: StreamLine = {
          seq,
          at: 1_700_000_000_000 + seq,
          text: plain,
          plain,
          terminator: 'newline'
        };
        const { block, batch } = classifier.classify(line);
        tracker.apply(block);
        if (batch) tracker.apply(batch);
      }
    };
    return { tracker, feed };
  }

  const GUILD_LINES = ["Newhaven, Adventurer's Guild", 'Obvious exits: south'];
  const ROAD_LINES = ['Newhaven, Narrow Road', 'Obvious exits: north'];

  it('keeps a location the realm stated outright', () => {
    const { tracker, feed } = session();
    feed(['Location:            1,2147', ...GUILD_LINES]);
    expect(tracker.current.room).toMatchObject({
      map: 1,
      number: 2147,
      resolvedBy: 'coordinates',
      confidence: 1
    });
  });

  it('still says coordinates after looking again', () => {
    const { tracker, feed } = session();
    feed(['Location:            1,2147', ...GUILD_LINES, ...GUILD_LINES]);
    expect(tracker.current.room.resolvedBy).toBe('coordinates');
  });

  it('re-derives when the room actually changed', () => {
    // Carrying a location past a real move would be the worst failure of all:
    // a confidently wrong position sends the pathfinder somewhere else.
    const { tracker, feed } = session();
    feed(['Location:            1,2147', ...GUILD_LINES]);
    tracker.observeCommand('s');
    feed(ROAD_LINES);
    expect(tracker.current.room).toMatchObject({
      name: 'Newhaven, Narrow Road',
      number: 2146,
      resolvedBy: 'movement'
    });
  });

  it('re-derives when the name differs without a move', () => {
    // Something moved us that we did not do. The old belief is worthless.
    const { tracker, feed } = session();
    feed(['Location:            1,2147', ...GUILD_LINES, ...ROAD_LINES]);
    expect(tracker.current.room.name).toBe('Newhaven, Narrow Road');
    expect(tracker.current.room.resolvedBy).not.toBe('coordinates');
  });
});

/*
 * These use the real realm data. Which room you are in is entirely a question
 * of how ambiguous real names are, and a hand-made world of three rooms cannot
 * express a city with four streets called "Guild Street".
 */
const realmFile = path.resolve('resources/world/rooms.jsonl.gz');
const realm = fs.existsSync(realmFile) ? WorldGraph.load(realmFile) : null;

describe.runIf(realm !== null && realm.size > 0)('keeping track while walking', () => {
  /** Guild Street runs south from 1,21; four of its rooms share one name. */
  const guildCorner = 'Intersection of Guild St. & River St.';

  it('follows a move into a room whose name is not unique', () => {
    const tracker = play(
      [
        'Location:   1,218',
        { send: 's' },
        'Guild Street',
        'Obvious exits: north, south, east, west'
      ],
      realm!
    );
    // Four rooms are called "Guild Street"; only the exit walked says which.
    expect(tracker.current.room.resolvedBy).toBe('movement');
    expect(`${tracker.current.room.map},${tracker.current.room.number}`).toBe('1,219');
  });

  it('reads a reprint of a namesake room by its exits, not by its name', () => {
    /*
     * The server reprints the room you are standing in unasked — when a fight
     * ends, and on a bare Enter. If a move is still in flight the reprint
     * looks exactly like the arrival, and the guard that told them apart read
     * only the name.
     *
     * **83.85% of this realm's edges lead to a room carrying the origin's
     * name**, so that guard was blind on almost every step. Estwall Street
     * runs north into Estwall Street; what separates them is that 1,5 prints
     * a west exit and 1,6 has none, and the server can only print exits the
     * realm records. So a block showing `west` cannot be 1,6 — the move is
     * still being answered, and the reprint takes nothing.
     */
    const tracker = play(
      [
        'Location:   1,5',
        { send: 'n' },
        'Estwall Street',
        'Obvious exits: north, south, west',
        'Estwall Street',
        'Obvious exits: north, south'
      ],
      realm!
    );

    expect(tracker.current.room.resolvedBy).toBe('movement');
    expect(`${tracker.current.room.map},${tracker.current.room.number}`).toBe('1,6');
    expect(tracker.pendingMoves).toBe(0);
  });

  /**
   * `You may not do that while you are mortally wounded!` — the server refusing
   * whatever was sent, without naming it.
   *
   * The most common sentence this client had never read: 33,402 across the
   * recorded sessions, 33,396 of them one session in which a character sat at
   * `[HP=-21]` while automation attacked, was refused, and died. A **step**
   * sent in that state is refused by this and nothing else, so its claim sat
   * outstanding — 126 seconds, measured — and `pendingMoves` gates the escape,
   * `Walker.start`, a loop's next leg and hitting back. The one moment a
   * character most needs to run is the one this took the escape away in.
   */
  it('gives back the move a refusal for being mortally wounded answered', () => {
    const tracker = play([
      'Guild Street',
      'Obvious exits: north, south',
      '[HP=-21/MA=12]: ',
      { send: 'n' },
      'You may not do that while you are mortally wounded!'
    ]);
    expect(tracker.pendingMoves).toBe(0);
  });

  /* And the exit is not written off with it: the step failed because the
     character is at zero, not because the corridor is shut. */
  it('does not read that refusal as a corridor the realm refuses', () => {
    const refused: string[] = [];
    const tracker = new CharacterTracker();
    const classifier = new Classifier({
      present: () => tracker.current.room.occupants.map((who) => who.name),
      mob: () => undefined
    });
    let seq = 0;
    for (const text of ['You may not do that while you are mortally wounded!']) {
      seq += 1;
      const { block } = classifier.classify({
        seq,
        at: seq,
        text,
        plain: text,
        terminator: 'newline'
      });
      // The type is what decides it: `direction-failed` is what
      // `SessionManager` blacklists an edge on, and this is deliberately not
      // one of those.
      refused.push(block.type);
    }
    expect(refused).toEqual(['command-refused']);
  });

  it('gives back the move a refused command queued, and keeps the walk placed', () => {
    /*
     * The one position this client has ever lost, replayed
     * (`logs/2026-08-29_21-18-33_main.mudcap.jsonl`). A walk sent
     * `go manhole` twice three milliseconds apart; the server ran the first
     * and *said the second out loud*, which is what it does with a word it
     * will not run. The refusal left a move queued that no room was coming
     * for, so the dark room the following `w` reached was resolved against
     * the phantom `go manhole` instead of against `w` — dead reckoning had no
     * direction that fitted, and three `rm`s went out to find the character
     * again.
     */
    const tracker = play(
      [
        'Location:   1,224',
        { send: 'go manhole' },
        { send: 'go manhole' },
        'Sewer Tunnel, Junction',
        'Obvious exits: north, south, east, west, up',
        'You say "go manhole"',
        { send: 'w' },
        "The room is very dark - you can't see anything"
      ],
      realm!
    );

    // West of 1,766 is 1,767, which the realm also records as dark — so the
    // arrival places itself with nothing to ask.
    expect(tracker.current.room.resolvedBy).toBe('dead-reckoning');
    expect(`${tracker.current.room.map},${tracker.current.room.number}`).toBe('1,767');
    expect(tracker.pendingMoves).toBe(0);
  });

  it('does not spend a queued direction on a room it did not reach', () => {
    /*
     * Two directions sent before either was answered, and the first hits a
     * wall. With a single pending slot the room that arrives was matched
     * against the *last* direction typed, so a run of moves resolved every
     * room against the wrong exit — quietly, and further from the truth with
     * every step.
     */
    const tracker = play(
      [
        'Location:   1,218',
        { send: 'e' },
        { send: 's' },
        'There is no exit in that direction!',
        'Guild Street',
        'Obvious exits: north, south, east, west'
      ],
      realm!
    );
    expect(tracker.current.room.resolvedBy).toBe('movement');
    expect(`${tracker.current.room.map},${tracker.current.room.number}`).toBe('1,219');
  });

  /*
   * The reported failure, as an assertion.
   *
   * A toll refusal went unread, so the step it answered stayed in the
   * expectation queue for ever. `pendingMoves` never fell, and `AutoCombat`
   * suppresses retaliation while a move is outstanding — so the character
   * stopped hitting back for the rest of the session. From the player's own
   * log, 2026-08-30:
   *
   *     Wealth: 0 copper farthings
   *     [HP=334/KAI=27]:e
   *     You do not have enough to cover the toll of 5 gold crowns.
   *     [HP=334/KAI=27]:The large wild dog snaps at you, ...   (x3, unanswered)
   */
  it('spends the queued direction on a toll it could not pay', () => {
    const tracker = play(
      [
        'Location:   1,218',
        { send: 'e' },
        'You do not have enough to cover the toll of 5 gold crowns.'
      ],
      realm!
    );
    expect(tracker.pendingMoves).toBe(0);
  });

  /* The same, for the three refusals read from the server's own source. Each
     one left the identical phantom move. */
  it('spends it on the other refusals that stop a step dead', () => {
    for (const refusal of [
      'Your current alignment prevents you from entering this exit.',
      'You may not enter that room while in combat.',
      'You are too heavy to move!'
    ]) {
      const tracker = play(['Location:   1,218', { send: 'e' }, refusal], realm!);
      expect(tracker.pendingMoves, refusal).toBe(0);
    }
  });

  it('keeps where it is when a look brings no name it can read', () => {
    /*
     * The room name has no marker of its own, so a line the classifier does
     * not recognise leaves the draft nameless and `Obvious exits:` completes a
     * room with nothing to look up. Throwing the location away at that point is
     * how one unparsed street corner blanked the map.
     */
    const tracker = play(
      ['Location:   1,21', { send: 'l' }, 'Obvious exits: south, east, west'],
      realm!
    );
    expect(`${tracker.current.room.map},${tracker.current.room.number}`).toBe('1,21');
  });

  it('reads a street corner as a room, so standing on one is not being lost', () => {
    const tracker = play(
      ['Location:   1,21', guildCorner, 'Obvious exits: south, east, west'],
      realm!
    );
    expect(tracker.current.room.name).toBe(guildCorner);
    expect(`${tracker.current.room.map},${tracker.current.room.number}`).toBe('1,21');
  });

  it('admits it is lost when a move lands somewhere it cannot name', () => {
    // Honest, not stubborn: only a room arriving *without* a move may keep the
    // old belief.
    const tracker = play(
      ['Location:   1,21', { send: 's' }, 'Obvious exits: north, south'],
      realm!
    );
    expect(tracker.current.room.map).toBeNull();
  });

  it.runIf(realm !== null && realm.size > 0)(
    'does not move the character when it only looked that way',
    () => {
      /*
       * `l n` prints the room to the north in full — name, description,
       * occupants, exits — and nothing in it says it is not where you are
       * standing. Applying it walked the character into the neighbour without
       * a step being taken, and every route planned afterwards started from
       * the wrong place.
       */
      const tracker = play(
        ['Location:   1,2140', { send: 'l n' }, 'Newhaven, Spell Shop', 'Obvious exits: south'],
        realm!
      );
      expect(`${tracker.current.room.map},${tracker.current.room.number}`).toBe('1,2140');
    }
  );

  it.runIf(realm !== null && realm.size > 0)('accepts every abbreviation of look', () => {
    for (const verb of ['l', 'lo', 'loo', 'look']) {
      const tracker = play(
        [
          'Location:   1,2140',
          { send: `${verb} north` },
          'Newhaven, Spell Shop',
          'Obvious exits: south'
        ],
        realm!
      );
      expect(`${tracker.current.room.map},${tracker.current.room.number}`).toBe('1,2140');
    }
  });

  it.runIf(realm !== null && realm.size > 0)(
    'still walks when the command really is a direction',
    () => {
      // The guard must not swallow movement: a bare `n` is still a step.
      const tracker = play(
        ['Location:   1,218', { send: 'n' }, 'Guild Street', 'Obvious exits: north, south'],
        realm!
      );
      expect(tracker.current.room.resolvedBy).toBe('movement');
      expect(`${tracker.current.room.map},${tracker.current.room.number}`).toBe('1,217');
    }
  );

  it.runIf(realm !== null && realm.size > 0)(
    'does not let a look consume the move queued behind it',
    () => {
      const tracker = play(
        [
          'Location:   1,218',
          { send: 'l n' },
          { send: 's' },
          'Guild Street',
          'Obvious exits: north, south, east, west',
          'Guild Street',
          'Obvious exits: north, south, east, west'
        ],
        realm!
      );
      // The first room answered the look and changed nothing; the second
      // answered the step.
      expect(`${tracker.current.room.map},${tracker.current.room.number}`).toBe('1,219');
    }
  );
});

/*
 * A socket that closes takes the character out of the realm, and nothing else.
 *
 * Found by the smoke test once the rail stopped disappearing along with the
 * connection: the phase stayed `in-game` after a disconnect, so the HUD went on
 * reporting vitals and a room for a character that was gone.
 */
describe('leaving the realm', () => {
  const arrive = (): CharacterTracker =>
    play([
      '[HP=98/MA=50]:',
      'Newhaven Village Entrance',
      'Obvious exits: north, south',
      'Name: Vaelor   Race: Human   Class: Warrior'
    ]);

  it('stops claiming the character is in the realm', () => {
    const tracker = arrive();
    expect(tracker.current.phase).toBe('in-game');
    tracker.leaveRealm();
    expect(tracker.current.phase).not.toBe('in-game');
  });

  /* A stale room is worse than none: the map draws a place the character is
     not, and a route planned on reconnect starts from it. */
  it('forgets where they were standing', () => {
    const tracker = arrive();
    expect(tracker.current.room.name).not.toBeNull();
    tracker.leaveRealm();
    expect(tracker.current.room.name).toBeNull();
    expect(tracker.current.room.map).toBeNull();
    expect(tracker.current.room.exits).toEqual([]);
  });

  /* Who they are is still the last true thing known, and it is what the tab
     and the offline card have to show. */
  it('keeps who they are', () => {
    const tracker = arrive();
    const { name, className } = tracker.current;
    tracker.leaveRealm();
    expect(tracker.current.name).toBe(name);
    expect(tracker.current.className).toBe(className);
  });

  it('reports whether anything actually changed, so a closed session is quiet', () => {
    const tracker = arrive();
    expect(tracker.leaveRealm()).toBe(true);
    // Twice is not two disconnections.
    expect(tracker.leaveRealm()).toBe(false);
  });

  /* A move sent before the socket died can never be answered now, and holding
     it would let the *next* session's first room consume it and resolve the
     wrong location off it. */
  it('drops moves that can no longer be answered', () => {
    const classifier = new Classifier();
    const tracker = new CharacterTracker();
    let seq = 0;
    const feed = (text: string): void => {
      seq += 1;
      const { block, batch } = classifier.classify({
        seq,
        at: 1_700_000_000_000 + seq,
        text,
        plain: text,
        terminator: 'newline'
      });
      tracker.apply(block);
      if (batch) tracker.apply(batch);
    };

    feed('[HP=98/MA=50]:');
    feed('Newhaven Village Entrance');
    feed('Obvious exits: north, south');
    tracker.observeCommand('n');
    tracker.observeCommand('n');
    expect(tracker.pendingCount).toBe(2);

    tracker.leaveRealm();
    expect(tracker.pendingCount).toBe(0);
  });

  /*
   * `l n` prints the neighbour in full and nothing in it says the character is
   * not standing there. The tracker has always honoured that; the console's
   * decoration needs the same answer, because it marks a room's *name* line
   * before the block is applied — and a button beside a peeked room sends that
   * room's command into the room the character is actually in, where
   * `go manhole` with no manhole is said out loud to everybody present.
   */
  it('says whether the next room block answers a peek or a step', () => {
    const tracker = new CharacterTracker();
    expect(tracker.nextRoomIsPeek).toBe(false);

    tracker.observeCommand('l n');
    expect(tracker.nextRoomIsPeek).toBe(true);

    // Read at the head and never shifted: the room block that consumes this
    // expectation has not been applied yet.
    expect(tracker.nextRoomIsPeek).toBe(true);
    expect(tracker.pendingCount).toBe(1);
  });

  it('reads a step as a step, and answers the queue in order', () => {
    const tracker = new CharacterTracker();
    tracker.observeCommand('n');
    tracker.observeCommand('l n');
    // The move is at the head, so the next room is somewhere the character is
    // going — the peek behind it does not make it one.
    expect(tracker.nextRoomIsPeek).toBe(false);
  });
});

/*
 * The `who` listing was parsed three phases ago and nothing ever read more than
 * the names — which is the wrong half. On a PvP realm the fact that matters
 * about somebody is what the realm thinks of them, and the listing states it.
 *
 * The lines here are verbatim from `npm run probe:who` against gmud-tgs:2427.
 */
describe('who else is in the realm', () => {
  const listing = (...rows: string[]): CharacterTracker =>
    play([
      '[HP=33]:',
      '         Current Adventurers',
      '         ===================',
      ...rows,
      '[HP=33]:'
    ]);

  it('keeps the whole row, not only the name', () => {
    const tracker = listing('         Vaelor                -  Apprentice S');
    expect(tracker.current.online).toHaveLength(1);
    expect(tracker.current.online[0]).toMatchObject({
      name: 'Vaelor',
      title: 'Apprentice',
      flags: 'S',
      provisional: false
    });
  });

  it('reads the alignment column, which is the PvP-relevant one', () => {
    const tracker = listing('         Outlaw   Grimjaw     -  Apprentice');
    expect(tracker.current.online[0]?.alignment).toBe('Outlaw');
  });

  /* Absent is not Neutral. A guessed alignment is the guess that gets somebody
     killed, and the reassuring guess is the dangerous one. */
  it('leaves the alignment null when the listing does not give one', () => {
    const tracker = listing('         Vaelor                -  Apprentice');
    expect(tracker.current.online[0]?.alignment).toBeNull();
  });

  it('refuses a word that is not one of the realm’s alignments', () => {
    const tracker = listing('         Sideways Grimjaw      -  Apprentice');
    // Either it parsed as a surname or not at all; what it must never do is
    // present `Sideways` as a standing the client can reason about.
    for (const entry of tracker.current.online) expect(entry.alignment).toBeNull();
  });

  /* A listing is authoritative: somebody absent from it has left. */
  it('replaces the roster rather than merging into it', () => {
    const tracker = listing(
      '         Vaelor                -  Apprentice',
      '         Yang                  -  Apprentice'
    );
    expect(tracker.current.online.map((entry) => entry.name)).toEqual(['Vaelor', 'Yang']);
  });
});

/*
 * Presence between listings, for free.
 *
 * A `who` costs a command from the budget walking and fighting spend from, so
 * re-asking to stay current is the expensive way to learn what the server is
 * already announcing.
 */
describe('keeping the roster true without asking', () => {
  const feeder = (): { tracker: CharacterTracker; feed: (text: string) => void } => {
    const classifier = new Classifier();
    const tracker = new CharacterTracker();
    let seq = 0;
    const feed = (text: string): void => {
      seq += 1;
      const { block, batch } = classifier.classify({
        seq,
        at: 1_700_000_000_000 + seq,
        text,
        plain: text,
        terminator: 'newline'
      });
      tracker.apply(block);
      if (batch) tracker.apply(batch, batch.rows);
    };
    return { tracker, feed };
  };

  it('adds somebody who walks in', () => {
    const { tracker, feed } = feeder();
    feed('[HP=33]:');
    feed('Grimjaw just entered the Realm.');
    expect(tracker.current.online.map((entry) => entry.name)).toEqual(['Grimjaw']);
  });

  /* An arrival is a name and nothing else. Saying more would be inventing it. */
  it('marks them provisional, with no alignment invented for them', () => {
    const { tracker, feed } = feeder();
    feed('[HP=33]:');
    feed('Grimjaw just entered the Realm.');
    expect(tracker.current.online[0]).toMatchObject({ alignment: null, provisional: true });
  });

  it('removes somebody who leaves, and somebody who drops', () => {
    const { tracker, feed } = feeder();
    feed('[HP=33]:');
    feed('Grimjaw just entered the Realm.');
    feed('Yang just entered the Realm.');
    feed('Grimjaw just left the Realm.');
    expect(tracker.current.online.map((entry) => entry.name)).toEqual(['Yang']);
    feed('Yang just disconnected!!!');
    expect(tracker.current.online).toEqual([]);
  });

  it('does not list the same person twice', () => {
    const { tracker, feed } = feeder();
    feed('[HP=33]:');
    feed('Grimjaw just entered the Realm.');
    feed('Grimjaw just entered the Realm.');
    expect(tracker.current.online).toHaveLength(1);
  });

  /* A listing confirms what an arrival could only name. */
  it('a later listing fills in what the arrival could not say', () => {
    const { tracker, feed } = feeder();
    feed('[HP=33]:');
    feed('Grimjaw just entered the Realm.');
    expect(tracker.current.online[0]?.provisional).toBe(true);
    feed('         Current Adventurers');
    feed('         ===================');
    feed('         Outlaw   Grimjaw     -  Apprentice');
    feed('[HP=33]:');
    expect(tracker.current.online[0]).toMatchObject({
      alignment: 'Outlaw',
      provisional: false
    });
  });

  it('empties the roster when the character leaves the realm', () => {
    const { tracker, feed } = feeder();
    feed('[HP=33]:');
    feed('Grimjaw just entered the Realm.');
    tracker.leaveRealm();
    expect(tracker.current.online).toEqual([]);
  });
});

/*
 * `inCombat` was a boolean, which answers "am I fighting" and nothing else.
 * Every decision worth automating needs the other half: what, and what is
 * hitting me. Assembled from blocks the classifier already produces — nothing
 * new is asked of the server and no pattern is guessed at.
 */
describe('the fight this character is in', () => {
  /*
   * A realm that names the two monsters these tests fight.
   *
   * Needed rather than decorative: a monster's attack text is realm data, so
   * `The orc rogue slashes you for 5 damage!` is one run of words with nothing
   * in the grammar to say where the name stops. Either the room or the realm's
   * table has to say, and a fight that starts before a room block has arrived
   * only has the table.
   */
  function combatWorld(): WorldGraph {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-combat-'));
    const file = path.join(dir, 'rooms.jsonl.gz');
    const header = JSON.stringify({
      v: 5,
      source: 'test',
      rooms: 0,
      generatedAt: 'x',
      mobs: [
        { n: 'orc rogue', hp: 30, d: 'h' },
        { n: 'cave rat', hp: 10, d: 'h' },
        { n: 'giant rat', hp: 12, d: 'h' }
      ]
    });
    fs.writeFileSync(file, zlib.gzipSync(header + '\n'));
    const graph = WorldGraph.load(file);
    fs.rmSync(dir, { recursive: true, force: true });
    return graph;
  }

  const fighting = (...lines: string[]): CharacterTracker =>
    play(
      ['[HP=98/MA=50]:', 'Name: Vaelor    Lives/CP: 3/12', '*Combat Engaged*', ...lines],
      combatWorld()
    );

  it('knows a fight is on, in the server’s own words', () => {
    expect(fighting().current.combat.engaged).toBe(true);
    expect(fighting().current.inCombat).toBe(true);
  });

  it('learns what it is fighting when it swings', () => {
    const tracker = fighting('You slash the orc rogue for 12 damage!');
    expect(tracker.current.combat.target).toBe('orc rogue');
  });

  /*
   * Being attacked says what is fighting *you*, which is a different question.
   * A rule that swings at `{target}` must not be handed the name of something
   * that merely hit you while you were fighting something else.
   */
  it('does not call something a target just because it hit you', () => {
    const tracker = fighting('The orc rogue slashes you for 5 damage!');
    expect(tracker.current.combat.target).toBeNull();
    expect(tracker.current.combat.attackers).toEqual(['orc rogue']);
  });

  it('counts a miss as an attacker too, because it is still fighting you', () => {
    expect(fighting('The orc rogue swings at you.').current.combat.attackers).toEqual([
      'orc rogue'
    ]);
  });

  /*
   * `*Combat Engaged*` names nothing, so the attack command it answers is the
   * only record of what was attacked — and it is the earliest the client can
   * know its target. Waiting for the first damage line left `{target}` empty
   * for the round in between, which is exactly when a round verb wants it.
   */
  it('binds the target from the attack command the engagement answers', () => {
    const tracker = play(['[HP=98]:', { send: 'pu orc rogue' }, '*Combat Engaged*'], combatWorld());
    expect(tracker.current.combat.target).toBe('orc rogue');
    expect(tracker.current.inCombat).toBe(true);
  });

  it('resolves a typed prefix to the occupant it reaches, as the server does', () => {
    const tracker = play(
      [
        '[HP=98]:',
        'Also here: giant rat.',
        'Obvious exits: north',
        { send: 'a giant' },
        '*Combat Engaged*'
      ],
      combatWorld()
    );
    expect(tracker.current.combat.target).toBe('giant rat');
  });

  it('resolves a typed base name to the modified occupant, as the server does', () => {
    // Measured live: `pu giant rat` engages a room's `small giant rat` — the
    // server's name-modifier system answers to the base name. Binding the
    // typed text would record a target no occupant matches, which reads as
    // "not fighting" while the server disagrees.
    const tracker = play(
      [
        '[HP=98]:',
        'Also here: small giant rat.',
        'Obvious exits: north',
        { send: 'pu giant rat' },
        '*Combat Engaged*'
      ],
      combatWorld()
    );
    expect(tracker.current.combat.target).toBe('small giant rat');
  });

  it('binds through the Off half of a disengage/engage pair', () => {
    // Re-attacking makes the server answer one command with `*Combat Off*`
    // then `*Combat Engaged*`. Consuming the slot on the Off left the Engaged
    // nothing to bind, the client believed it had no target, and it re-asked
    // on the next state change — the loop captured live on 2026-08-26.
    const tracker = play(
      ['[HP=98]:', { send: 'pu orc rogue' }, '*Combat Off*', '*Combat Engaged*'],
      combatWorld()
    );
    expect(tracker.current.combat.target).toBe('orc rogue');
  });

  it('drops the binding when another command intervenes', () => {
    // An engagement two commands after the attack is an attribution nobody
    // can make — the same one-slot rule the unmodelled-command record follows.
    const tracker = play(
      ['[HP=98]:', { send: 'pu orc rogue' }, { send: 'l' }, '*Combat Engaged*'],
      combatWorld()
    );
    expect(tracker.current.combat.target).toBeNull();
  });

  it('binds nothing from a bare attack verb', () => {
    // `a` alone falls back to the server's own LastTarget, which this client
    // cannot read; a guessed name is a name a rule would swing at.
    const tracker = play(['[HP=98]:', { send: 'a' }, '*Combat Engaged*'], combatWorld());
    expect(tracker.current.combat.target).toBeNull();
  });

  it('never overwrites the target of a fight already in progress', () => {
    const tracker = play(
      [
        '[HP=98]:',
        { send: 'pu orc rogue' },
        '*Combat Engaged*',
        'You slash the orc rogue for 12 damage!',
        { send: 'pu cave rat' },
        '*Combat Engaged*'
      ],
      combatWorld()
    );
    // The engagement of a fight already running says nothing new; the damage
    // lines are what move the target.
    expect(tracker.current.combat.target).toBe('orc rogue');
  });

  /*
   * The dead leave the attacker list with the kill. They used to stay, and in
   * the two lines between the experience line and `*Combat Off*` retaliation
   * read the corpse as something still swinging and attacked it — captured
   * live, once per kill.
   */
  it('takes a dead monster out of the attacker list with the kill', () => {
    const tracker = fighting(
      'The orc rogue slashes you for 5 damage!',
      'You slash the orc rogue for 40 damage!',
      'You gain 25 experience.'
    );
    expect(tracker.current.combat.target).toBeNull();
    expect(tracker.current.combat.attackers).toEqual([]);
  });

  it('drops an attacker the server says is not there', () => {
    // `Your command had no effect.` — the same cleanup a death does, for the
    // same reason: something absent cannot be attacking this character.
    const tracker = play(
      [
        '[HP=98]:',
        'Also here: orc rogue.',
        'Obvious exits: north',
        'The orc rogue slashes you for 5 damage!',
        { send: 'pu orc rogue' },
        'Your command had no effect.'
      ],
      combatWorld()
    );
    expect(tracker.current.combat.attackers).toEqual([]);
    expect(tracker.current.room.occupants).toEqual([]);
  });

  it('drops one the room listing had already dropped', () => {
    /*
     * The state a client cannot get out of on its own, from the player's log
     * of 2026-09-02 (`2026-09-02_18-07-07_festus.mudcap.jsonl`, t=4865201): a
     * step the client had lost track of took the character out of the room, a
     * rat that had lunged a second earlier stayed in `attackers`, and the room
     * block that arrived listed nobody at all — so the occupant filter matched
     * nothing and the whole correction was skipped. `Walker.fighting` reads
     * `attackers`, so the lap stood still; `retaliation` re-proposed the
     * attack on every state change; and every one came back to this sentence
     * to be refused by it. Three more `pu`s over the following forty seconds,
     * into a room the client had itself just listed as empty.
     */
    const tracker = play(
      [
        '[HP=98]:',
        'Also here: orc rogue.',
        'Obvious exits: north',
        'The orc rogue slashes you for 5 damage!',
        // The room says the rat is gone before the attack is even refused.
        'Sewer Tunnel',
        'Obvious exits: north',
        { send: 'pu orc rogue' },
        'Your command had no effect.'
      ],
      combatWorld()
    );
    expect(tracker.current.room.occupants).toEqual([]);
    expect(tracker.current.combat.attackers).toEqual([]);
  });

  /* Being fought by three things is the situation that decides whether to run,
     and it is exactly the situation a single `attacker` field hides. */
  it('keeps every attacker, newest first', () => {
    const tracker = fighting(
      'The orc rogue slashes you for 5 damage!',
      'The cave rat bites you for 2 damage!',
      'The orc rogue slashes you for 4 damage!'
    );
    expect(tracker.current.combat.attackers).toEqual(['orc rogue', 'cave rat']);
  });

  it('recognises a blow from a player, who has no article', () => {
    // Named by grammar alone, so the room has to vouch for him: `Acid burns
    // you for 1 damage!` has the same shape and names nobody.
    const tracker = fighting(
      'Blah',
      'Also here: Grimjaw.',
      'Obvious exits: north',
      'Grimjaw slashes you for 20 damage!'
    );
    expect(tracker.current.combat.attackers).toEqual(['Grimjaw']);
  });

  it('counts blows either way, so a card can say how it is going', () => {
    const tracker = fighting(
      'You slash the orc rogue for 12 damage!',
      'The orc rogue slashes you for 5 damage!'
    );
    expect(tracker.current.combat.blows).toBe(2);
  });

  it('remembers when the last blow landed, for mid-round timing', () => {
    const tracker = fighting('You slash the orc rogue for 12 damage!');
    expect(tracker.current.combat.lastBlowAt).not.toBeNull();
  });

  /*
   * A stale target is worse than none: a rule that attacks `{target}` would
   * swing at something that is not there, in a room that may have somebody else
   * in it.
   */
  it('forgets the fight when the server says it is over', () => {
    const classifier = new Classifier();
    const tracker = new CharacterTracker();
    let seq = 0;
    const feed = (text: string): void => {
      seq += 1;
      const { block, batch } = classifier.classify({
        seq,
        at: 1_700_000_000_000 + seq,
        text,
        plain: text,
        terminator: 'newline'
      });
      tracker.apply(block);
      if (batch) tracker.apply(batch, batch.rows);
    };

    feed('[HP=98/MA=50]:');
    feed('*Combat Engaged*');
    feed('You slash the orc rogue for 12 damage!');
    expect(tracker.current.combat.target).toBe('orc rogue');

    feed('*Combat Off*');
    expect(tracker.current.combat.target).toBeNull();
    expect(tracker.current.combat.attackers).toEqual([]);
    expect(tracker.current.inCombat).toBe(false);
  });

  /* A fight cannot continue through a closed socket, and a remembered target
     would be the first thing a rule swung at on reconnecting. */
  it('forgets the fight when the character leaves the realm', () => {
    const tracker = fighting('You slash the orc rogue for 12 damage!');
    tracker.leaveRealm();
    expect(tracker.current.combat).toEqual({
      engaged: false,
      target: null,
      targetEntity: null,
      health: null,
      attackers: [],
      lastBlowAt: null,
      blows: 0
    });
  });
});

/*
 * The party roster is the only place another character's health is visible, and
 * it costs one command rather than a second connection — which makes it the
 * most valuable thing on this server for a client running four characters.
 *
 * Every line here is verbatim from `npm run probe:party`: two characters on
 * the test realm, one inviting and the other joining. The mana column would have
 * been got wrong from a single sample.
 */
describe('the party this character travels with', () => {
  const feeder = (): { tracker: CharacterTracker; feed: (text: string) => void } => {
    const classifier = new Classifier();
    const tracker = new CharacterTracker();
    let seq = 0;
    const feed = (text: string): void => {
      seq += 1;
      const { block, batch } = classifier.classify({
        seq,
        at: 1_700_000_000_000 + seq,
        text,
        plain: text,
        terminator: 'newline'
      });
      tracker.apply(block);
      if (batch) tracker.apply(batch, batch.rows);
    };
    return { tracker, feed };
  };

  const roster = (): CharacterTracker => {
    const { tracker, feed } = feeder();
    feed('[HP=33]:');
    feed('The following people are in your travel party:');
    feed('  Vaelor                        (Warrior)             [H:100%]  - Frontrank');
    feed('  Soul                          (Paladin)    [M:100%] [H:100%]  - Backrank');
    feed('[HP=33]:');
    return tracker;
  };

  it('reads everyone in it', () => {
    expect(roster().current.party.members.map((member) => member.name)).toEqual(['Vaelor', 'Soul']);
  });

  it('reads their class and where they stand', () => {
    const [vaelor, soul] = roster().current.party.members;
    expect(vaelor).toMatchObject({ className: 'Warrior', rank: 'front' });
    expect(soul).toMatchObject({ className: 'Paladin', rank: 'back' });
  });

  /* The one fact worth having: another character's health, without a second
     connection. As a fraction, like every other vital. */
  it('reads their health as a fraction', () => {
    expect(roster().current.party.members[0]?.health).toBe(1);
  });

  /*
   * The mana column is optional — a warrior has none — exactly as it is in the
   * status line. Reading one sample would have produced a pattern that silently
   * never matched a caster, or one that read a caster's mana as its health.
   */
  it('leaves mana null for a class that has none, and reads it for one that does', () => {
    const [vaelor, soul] = roster().current.party.members;
    expect(vaelor?.mana).toBeNull();
    expect(soul?.mana).toBe(1);
    expect(vaelor?.health).toBe(1);
  });

  /*
   * A resting member used to take the whole party with it: the flag between the
   * health and the rank matched nothing, so the row qualified as nothing, two
   * members became one, and one member is not a party — the card vanished the
   * moment somebody sat down (live, 2026-08-27).
   */
  it('keeps the party when a member is resting, and says which one', () => {
    const { tracker, feed } = feeder();
    feed('[HP=101/KAI=5]:');
    feed('The following people are in your travel party:');
    feed('  Vaelor                        (Mystic)     [M:100%] [H:100%]  - Frontrank');
    feed('  Soul Guardian                 (Warrior)             [H:100%]R - Frontrank');
    feed('[HP=101/KAI=5]:');
    const [vaelor, soul] = tracker.current.party.members;
    expect(tracker.current.party.members).toHaveLength(2);
    expect(vaelor?.activity).toBeNull();
    expect(soul?.activity).toEqual({ state: 'resting' });
  });

  /* A letter nothing has established keeps its letter and claims nothing. */
  it('keeps a flag it cannot name rather than expanding it', () => {
    const { tracker, feed } = feeder();
    feed('[HP=590/754]:');
    feed('The following people are in your travel party:');
    feed('  Alucard Vampire                (Gypsy)      [M: 81%] [H:100%]P  - Frontrank');
    feed('  Ultralisk SevenHundred         (Witchunter)          [H: 78%]P  - Frontrank');
    feed('[HP=590/754]:');
    expect(tracker.current.party.members[0]?.activity).toEqual({ state: 'unknown', flag: 'P' });
  });

  /*
   * The free half of the maintained listing: a listing establishes who is
   * resting and the sentence keeps it true until the next one. It is said about
   * anybody in the room, so it counts only for a member the roster has.
   */
  it('takes a member sitting down from the sentence that announces it', () => {
    const tracker = roster();
    const rests = (text: string): void => {
      const { block } = new Classifier().classify({
        seq: 9,
        at: 9,
        text,
        plain: text,
        terminator: 'newline'
      });
      tracker.apply(block);
    };
    rests('Soul stops to rest.');
    rests('Stranger kneels to meditate.');
    expect(tracker.current.party.members[1]?.activity).toEqual({ state: 'resting' });
    expect(tracker.current.party.members.map((member) => member.name)).toEqual(['Vaelor', 'Soul']);
    rests('Soul kneels to meditate.');
    expect(tracker.current.party.members[1]?.activity).toEqual({ state: 'meditating' });
  });

  /*
   * `mid` answers `You have moved to the middle ranks of your group.` and the
   * pattern knew only front and back, so the middle rank was read as the front
   * one — a formation the player had just changed, reported as its opposite.
   */
  it('moves this character to the middle rank when the server says so', () => {
    const { tracker, feed } = feeder();
    feed('[HP=33]:');
    feed('Name: Soul            Lives/CP: 3/0');
    feed('[HP=33]:');
    feed('The following people are in your travel party:');
    feed('  Vaelor                        (Warrior)             [H:100%]  - Frontrank');
    feed('  Soul                          (Paladin)    [M:100%] [H:100%]  - Backrank');
    feed('[HP=33]:');
    feed('You have moved to the middle ranks of your group.');
    expect(tracker.current.party.members[1]?.rank).toBe('mid');
  });

  it('knows who it is following, when it is not leading', () => {
    const { tracker, feed } = feeder();
    feed('[HP=24/MA=18]:');
    feed('You are following Vaelor.');
    expect(tracker.current.party.following).toBe('Vaelor');
  });

  /*
   * `follow` aimed at somebody already being followed answers with the same
   * fact and the word `already` in it. Unread, the client concluded it was
   * following nobody — measured in the overnight run's first minute, where it
   * re-formed the party every two minutes for as long as it ran.
   */
  it('reads the refusal that restates who it is following', () => {
    const { tracker, feed } = feeder();
    feed('[HP=24/MA=18]:');
    feed('You are already following Vaelor.');
    expect(tracker.current.party.following).toBe('Vaelor');
  });

  /* A party of one is not a party. The server still prints your own row. */
  it('reports no party when there is nobody else in it', () => {
    const { tracker, feed } = feeder();
    feed('[HP=33]:');
    feed('You are not in a party at the present time.');
    feed('  Vaelor                        (Warrior)             [H:100%]  - Frontrank');
    feed('[HP=33]:');
    expect(tracker.current.party).toEqual({
      engaged: {},
      threatened: {},
      following: null,
      members: []
    });
  });

  it('adds somebody who starts following, with nothing invented for them', () => {
    const { tracker, feed } = feeder();
    feed('[HP=33]:');
    feed('The following people are in your travel party:');
    feed('  Vaelor                        (Warrior)             [H:100%]  - Frontrank');
    feed('  Soul                          (Paladin)    [M:100%] [H:100%]  - Frontrank');
    feed('[HP=33]:');
    feed('Thorn started to follow you.');
    const thorn = tracker.current.party.members.find((member) => member.name === 'Thorn');
    // The announcement carries no health, and null is the honest answer.
    expect(thorn).toEqual({
      name: 'Thorn',
      className: null,
      health: null,
      mana: null,
      rank: null,
      activity: null,
      invited: false,
      vitals: null
    });
  });

  /*
   * An invitation, from the moment it goes out until it is answered.
   *
   * Verbatim from a live session on 2026-08-28: `invite soul`, `par` before the
   * answer, then the acceptance. The listing in the middle is the one that used
   * to close the card — `[Invited]` matched nothing, so a roster of two fell to
   * one row and a party of one is no party.
   */
  it('keeps the party while an invitation is outstanding', () => {
    const { tracker, feed } = feeder();
    feed('[HP=101/KAI=5]:');
    feed('You have invited Soul to follow you.');
    // Before any listing: the offer is the whole roster, and it is still a card.
    expect(tracker.current.party.members).toEqual([
      {
        name: 'Soul',
        className: null,
        health: null,
        mana: null,
        rank: null,
        activity: null,
        invited: true,
        vitals: null
      }
    ]);

    feed('The following people are in your travel party:');
    feed('  Vaelor                        (Mystic)     [M:100%] [H:100%]  - Frontrank');
    feed('  Soul Guardian                 (Warrior)    [Invited]');
    feed('[HP=101/KAI=5]:');
    const [vaelor, soul] = tracker.current.party.members;
    expect(vaelor).toMatchObject({ name: 'Vaelor', rank: 'front', invited: false });
    // The row carries a class and nothing else it has not been told.
    expect(soul).toMatchObject({
      name: 'Soul',
      className: 'Warrior',
      health: null,
      rank: null,
      invited: true,
      vitals: null
    });
  });

  /*
   * Accepting is an announcement about somebody already on the roster, and the
   * entry has to stop being an offer. Dropping it as a name already known would
   * leave `invited` set for ever: the card would go on waiting for an answer
   * that has arrived.
   */
  it('turns an invitation into a member when it is accepted', () => {
    const { tracker, feed } = feeder();
    feed('[HP=101/KAI=5]:');
    feed('You have invited Soul to follow you.');
    feed('Soul started to follow you.');
    expect(tracker.current.party.members).toMatchObject([{ name: 'Soul', invited: false }]);
  });

  /* `uninvite soul`: withdrawn before it was ever accepted. */
  it('takes an invitation off when it is withdrawn', () => {
    const { tracker, feed } = feeder();
    feed('[HP=101/KAI=5]:');
    feed('You have invited Soul to follow you.');
    feed('Soul has been removed from your followers.');
    expect(tracker.current.party).toEqual({
      engaged: {},
      threatened: {},
      following: null,
      members: []
    });
  });

  /*
   * Being invited is not being in a party. The incoming sentence names a
   * `leader` rather than a `player`, and nothing has been accepted — the roster
   * that would say otherwise is the leader's.
   */
  it('joins no party on an invitation this character received', () => {
    const { tracker, feed } = feeder();
    feed('[HP=101/KAI=5]:');
    feed('Vaelor has invited you to follow him.');
    expect(tracker.current.party).toEqual({
      engaged: {},
      threatened: {},
      following: null,
      members: []
    });
  });

  it('removes somebody who stops', () => {
    const { tracker, feed } = feeder();
    feed('[HP=33]:');
    feed('The following people are in your travel party:');
    feed('  Vaelor                        (Warrior)             [H:100%]  - Frontrank');
    feed('  Soul                          (Paladin)    [M:100%] [H:100%]  - Frontrank');
    feed('  Thorn                         (Ranger)              [H:80%]   - Backrank');
    feed('[HP=33]:');
    feed('Soul is no longer following you.');
    expect(tracker.current.party.members.map((m) => m.name)).toEqual(['Vaelor', 'Thorn']);
  });

  it('follows a rank change', () => {
    const { tracker, feed } = feeder();
    feed('[HP=33]:');
    feed('The following people are in your travel party:');
    feed('  Vaelor                        (Warrior)             [H:100%]  - Frontrank');
    feed('  Soul                          (Paladin)    [M:100%] [H:100%]  - Frontrank');
    feed('[HP=33]:');
    feed('Soul just moved to the back rank in your group.');
    expect(tracker.current.party.members.find((m) => m.name === 'Soul')?.rank).toBe('back');
  });

  it('ends the party when this character stops following', () => {
    const { tracker, feed } = feeder();
    feed('[HP=24/MA=18]:');
    feed('You are following Vaelor.');
    feed('You are no longer following Vaelor.');
    expect(tracker.current.party).toEqual({
      engaged: {},
      threatened: {},
      following: null,
      members: []
    });
  });
});

/*
 * Somebody walking into *this room* is a different fact from entering the
 * realm, and the more urgent one: the realm is large and this room is where a
 * fight happens.
 */
describe('who is in the room, between looks', () => {
  const feeder = (): { tracker: CharacterTracker; feed: (text: string) => void } => {
    const classifier = new Classifier();
    const tracker = new CharacterTracker();
    let seq = 0;
    const feed = (text: string): void => {
      seq += 1;
      const { block, batch } = classifier.classify({
        seq,
        at: 1_700_000_000_000 + seq,
        text,
        plain: text,
        terminator: 'newline'
      });
      tracker.apply(block);
      if (batch) tracker.apply(batch, batch.rows);
    };
    return { tracker, feed };
  };

  const inRoom = (): { tracker: CharacterTracker; feed: (text: string) => void } => {
    const made = feeder();
    made.feed('[HP=33]:');
    made.feed('Guild Street');
    made.feed('Also here: Nathaniel.');
    made.feed('Obvious exits: north, south');
    return made;
  };

  it('adds somebody who walks in', () => {
    const { tracker, feed } = inRoom();
    feed('Soul walks into the room from the north.');
    expect(names(tracker.current.room.occupants)).toEqual(['Nathaniel', 'Soul']);
  });

  it('removes somebody who walks out', () => {
    const { tracker, feed } = inRoom();
    feed('Soul walks into the room from the north.');
    feed('Soul just left to the north.');
    expect(names(tracker.current.room.occupants)).toEqual(['Nathaniel']);
  });

  it('does not list the same person twice', () => {
    const { tracker, feed } = inRoom();
    feed('Soul walks into the room from the north.');
    feed('Soul walks into the room from the north.');
    expect(names(tracker.current.room.occupants).filter((who) => who === 'Soul')).toHaveLength(1);
  });

  /* `Also here:` remains authoritative and replaces the list outright. */
  it('is overruled by the next room the server describes', () => {
    const { tracker, feed } = inRoom();
    feed('Soul walks into the room from the north.');
    feed('Newhaven, Docks');
    feed('Also here: ferryman.');
    feed('Obvious exits: north');
    expect(names(tracker.current.room.occupants)).toEqual(['ferryman']);
  });

  /*
   * `<Name> walks into the room from the east.` is composed in `Player.cs` and
   * nowhere else — a monster's arrival comes out of `MobType.MoveMessage`,
   * which is realm data and reads nothing like it. So the sentence itself says
   * this is a player, and classifying it would only be able to weaken that:
   * somebody who has not appeared in a listing yet is a capitalised name and
   * nothing else, which is precisely the unplaced case.
   */
  it('takes somebody walking in as a player, because only a player produces that line', () => {
    const { tracker, feed } = inRoom();
    feed('Soul walks into the room from the north.');
    const soul = tracker.current.room.occupants.find((who) => who.name === 'Soul');
    expect(soul?.kind).toBe('player');
  });
});

/*
 * Which of the two kinds each thing in the room is, against the realm this
 * client actually ships. The classifier has its own tests; this is the wiring —
 * that the tracker reaches the realm data at all, and that a listing arriving
 * afterwards corrects what it could not place at the time.
 */
describe('what is in the room, and who', () => {
  const feeder = (): { tracker: CharacterTracker; feed: (text: string) => void } => {
    const classifier = new Classifier();
    const tracker = new CharacterTracker(realm ?? undefined);
    let seq = 0;
    const feed = (text: string): void => {
      seq += 1;
      const { block, batch } = classifier.classify({
        seq,
        at: 1_700_000_000_000 + seq,
        text,
        plain: text,
        terminator: 'newline'
      });
      tracker.apply(block);
      if (batch) tracker.apply(batch, batch.rows);
    };
    return { tracker, feed };
  };

  it.skipIf(realm === null)('reads a monster the shipped realm names', () => {
    const { tracker, feed } = feeder();
    feed('[HP=33]:');
    feed('Guild Street');
    feed('Also here: giant rat.');
    feed('Obvious exits: north');

    const rat = tracker.current.room.occupants[0];
    expect(rat?.kind).toBe('mob');
    // `giant rat` is one of the twenty-one names the realm data disagrees with
    // itself about, which is exactly why the flag exists.
    expect(rat?.disposition).toBe('hostile');
    expect(rat?.uncertain).toBe(true);
  });

  /*
   * The entry probe sends `l` and `sc` in one breath, so `Also here:` routinely
   * arrives before the first listing. Somebody standing in the room whose name
   * nothing had placed would stay unplaced until the next time a room completed
   * — which in a room somebody is waiting in is the moment it matters.
   */
  it('re-reads the room when a listing finally says who is a player', () => {
    const { tracker, feed } = feeder();
    feed('[HP=33]:');
    feed('Guild Street');
    feed('Also here: Grimjaw.');
    feed('Obvious exits: north');
    expect(tracker.current.room.occupants[0]?.kind).toBe('unknown');

    feed('Current Adventurers');
    feed('  Neutral  Grimjaw  -  Apprentice');
    feed('[HP=33]:');
    expect(tracker.current.room.occupants[0]?.kind).toBe('player');
  });

  /*
   * **A name can belong to both**, and this is not hypothetical: the shipped
   * realm has a monster called `nathaniel`, and Nathaniel is also a character
   * on the test realm. Nothing in the `Also here:` line separates them.
   *
   * The roster wins, which is why it is tested first in `classifyOccupant`. The
   * other order would have the client treat a person as a monster and — with
   * auto-combat on and the realm calling that monster hostile — swing at them.
   */
  it.skipIf(realm === null)('lets the roster overrule a monster of the same name', () => {
    const { tracker, feed } = feeder();
    feed('[HP=33]:');
    feed('Guild Street');
    feed('Also here: Nathaniel.');
    feed('Obvious exits: north');
    // With nothing to say otherwise, the realm's monster table is the best
    // evidence there is.
    expect(tracker.current.room.occupants[0]?.kind).toBe('mob');

    feed('Current Adventurers');
    feed('  Neutral  Nathaniel  -  Apprentice');
    feed('[HP=33]:');
    expect(tracker.current.room.occupants[0]?.kind).toBe('player');
    expect(tracker.current.room.occupants[0]?.disposition).toBeNull();
  });
});

/*
 * What is carried, and what is on the floor, between `i` commands.
 *
 * The server volunteers both, so keeping them true costs nothing — the same
 * reasoning as the realm roster and the room's occupants, and the same rule:
 * a listing is authoritative and replaces what is here.
 */
describe('what is carried, between listings', () => {
  const feeder = (): { tracker: CharacterTracker; feed: (text: string) => void } => {
    const classifier = new Classifier();
    const tracker = new CharacterTracker();
    let seq = 0;
    const feed = (text: string): void => {
      seq += 1;
      const { block, batch } = classifier.classify({
        seq,
        at: 1_700_000_000_000 + seq,
        text,
        plain: text,
        terminator: 'newline'
      });
      tracker.apply(block);
      if (batch) tracker.apply(batch, batch.rows);
    };
    return { tracker, feed };
  };

  /** The carried names, which is what most of these assertions are about. */
  const held = (tracker: CharacterTracker): string[] =>
    tracker.current.inventory.items.map((item) => item.name);

  const carrying = (): { tracker: CharacterTracker; feed: (text: string) => void } => {
    const made = feeder();
    made.feed('[HP=33]:');
    made.feed('You are carrying a torch, a rusty dagger.');
    made.feed('You have no keys.');
    made.feed('Wealth: 40 copper farthings');
    // The batch closes on a status line, exactly as it does on the wire.
    made.feed('[HP=33]:');
    return made;
  };

  it('adds something this character picked up', () => {
    const { tracker, feed } = carrying();
    feed('You took a healing potion.');
    expect(held(tracker)).toContain('a healing potion');
  });

  it('removes something it dropped', () => {
    const { tracker, feed } = carrying();
    feed('You dropped a torch.');
    expect(held(tracker).some((i) => /torch/.test(i))).toBe(false);
  });

  /*
   * `player-gets` covers two different sentences and the `player` capture is
   * what separates them. Getting it backwards would put another player's loot
   * in this character's pack.
   */
  it('does not put somebody else’s loot in this character’s pack', () => {
    const { tracker, feed } = carrying();
    const before = tracker.current.inventory.items.length;
    feed('Grimjaw picks up a healing potion.');
    expect(tracker.current.inventory.items).toHaveLength(before);
  });

  it('tracks what is on the floor as well', () => {
    const { tracker, feed } = feeder();
    feed('[HP=33]:');
    feed('Guild Street');
    feed('You notice a torch here.');
    feed('Obvious exits: north');
    expect(tracker.current.room.items.map((i) => i.name)).toContain('a torch');

    feed('Grimjaw drops a shield.');
    expect(tracker.current.room.items.map((i) => i.name)).toContain('a shield');
    feed('Grimjaw picks up a shield.');
    expect(tracker.current.room.items.some((i) => /shield/.test(i.name))).toBe(false);
  });

  it('moves an item between the floor and the pack in one step', () => {
    const { tracker, feed } = feeder();
    feed('[HP=33]:');
    feed('Guild Street');
    feed('You notice a torch here.');
    feed('Obvious exits: north');
    feed('You took a torch.');
    expect(held(tracker)).toContain('a torch');
    expect(tracker.current.room.items.some((i) => /torch/.test(i.name))).toBe(false);
  });

  /*
   * Both sources keep their articles in every capture so far, so this passes
   * without normalisation — it is here for the day one of them does not, when
   * the cost would be an item that can be picked up and never put down.
   */
  it('matches an item however the article is spelled', () => {
    const { tracker, feed } = carrying();
    feed('You dropped rusty dagger.');
    expect(held(tracker).some((i) => /dagger/.test(i))).toBe(false);
  });

  /*
   * The one this was reported for. An `i` listing annotates anything worn or
   * wielded with the slot it is in; the sentence reporting it put down does
   * not. Captured verbatim:
   *
   *     [HP=34]:i
   *     You are carrying padded helm (Head), padded vest (Torso), ...
   *     [HP=34]:drop quar
   *     You dropped quarterstaff.
   *
   * The card went on listing the quarterstaff until the next `i` — which is the
   * command the maintained listing exists to make unnecessary.
   */
  it('removes something equipped, whose listing carried the slot it was in', () => {
    const { tracker, feed } = feeder();
    feed('[HP=34]:');
    feed('You are carrying padded helm (Head), padded vest (Torso), quarterstaff (Weapon Hand)');
    feed('You have no keys.');
    feed('Wealth: 0 copper farthings');
    feed('Encumbrance: 500/3360 - None [14%]');
    feed('[HP=34]:');
    expect(tracker.current.inventory.items).toHaveLength(3);

    feed('You dropped quarterstaff.');
    feed('You dropped padded vest.');
    expect(held(tracker)).toEqual(['padded helm']);
    // And they are on the floor, where they were dropped.
    expect(tracker.current.room.items.map((i) => i.name)).toEqual(['quarterstaff', 'padded vest']);
  });

  /*
   * The pack holds instances, not names. A second helm picked up while one is
   * worn is a second helm — the server lists both (`padded gloves (Hands), …,
   * padded gloves`, captured live) — and it used to vanish from the card
   * because the name was already there.
   */
  it('adds a second copy of something already held in a slot', () => {
    const { tracker, feed } = feeder();
    feed('[HP=34]:');
    feed('You are carrying padded helm (Head)');
    feed('You have no keys.');
    feed('[HP=34]:');
    feed('You took padded helm.');
    expect(tracker.current.inventory.items).toEqual([
      { name: 'padded helm', source: 'wire', slot: 'Head', equipped: true, charges: null },
      { name: 'padded helm', source: 'wire', slot: null, equipped: false, charges: null }
    ]);
  });

  it('lists the same thing twice when the character has two', () => {
    const { tracker, feed } = carrying();
    feed('You took a torch.');
    expect(held(tracker).filter((i) => /torch/.test(i))).toHaveLength(2);
  });

  /*
   * The capture of 2026-08-26: two pairs of gloves, one worn, one spare.
   *
   *     You are carrying padded helm (Head), padded gloves (Hands), padded pants
   *     (Legs), padded boots (Feet), quarterstaff (Weapon Hand), padded gloves
   *     [HP=34]:hid glov
   *     You hid padded gloves.
   *     [HP=34]:i
   *     You are carrying padded helm (Head), padded gloves (Hands), …
   */
  const twoPairs = (): { tracker: CharacterTracker; feed: (text: string) => void } => {
    const made = feeder();
    made.feed('[HP=34]:');
    made.feed('You are carrying padded helm (Head), padded gloves (Hands), padded pants');
    made.feed('(Legs), padded boots (Feet), quarterstaff (Weapon Hand), padded gloves');
    made.feed('You have no keys.');
    made.feed('Wealth: 0 copper farthings');
    made.feed('Encumbrance: 300/3360 - None [8%]');
    made.feed('[HP=34]:');
    return made;
  };

  const gloves = (tracker: CharacterTracker) =>
    tracker.current.inventory.items.filter((item) => item.name === 'padded gloves');

  it('lists two of a thing as two rows', () => {
    const { tracker } = twoPairs();
    expect(gloves(tracker)).toEqual([
      { name: 'padded gloves', source: 'wire', slot: 'Hands', equipped: true, charges: null },
      { name: 'padded gloves', source: 'wire', slot: null, equipped: false, charges: null }
    ]);
  });

  it('hides one instance out of the pack, and onto no floor', () => {
    const { tracker, feed } = twoPairs();
    feed('You hid padded gloves.');
    expect(gloves(tracker)).toEqual([
      { name: 'padded gloves', source: 'wire', slot: 'Hands', equipped: true, charges: null }
    ]);
    // Hidden is exactly what `You notice` does not show.
    expect(tracker.current.room.items).toEqual([]);
  });

  it('drops the spare before the worn one', () => {
    // The server's own order: `drop gloves` with one pair on and one in the
    // pack drops the pack's. Removing by name took both; removing in listing
    // order took the worn pair.
    const { tracker, feed } = twoPairs();
    feed('You dropped padded gloves.');
    expect(gloves(tracker)).toEqual([
      { name: 'padded gloves', source: 'wire', slot: 'Hands', equipped: true, charges: null }
    ]);
    expect(tracker.current.room.items.map((i) => i.name)).toEqual(['padded gloves']);
  });

  it('drops as many as the server counted', () => {
    const { tracker, feed } = twoPairs();
    feed('You dropped 2 padded gloves.');
    expect(gloves(tracker)).toEqual([]);
    expect(held(tracker)).toEqual(['padded helm', 'padded pants', 'padded boots', 'quarterstaff']);
  });

  it('takes as many as the server counted', () => {
    const { tracker, feed } = twoPairs();
    feed('You dropped 2 padded gloves.');
    feed('You took 2 padded gloves.');
    expect(gloves(tracker)).toHaveLength(2);
  });

  it('changes nothing on a refused drop', () => {
    const { tracker, feed } = twoPairs();
    feed("You don't have 3 gloves to drop!");
    expect(gloves(tracker)).toHaveLength(2);
  });

  it('wears one spare rather than every row of the name', () => {
    const { tracker, feed } = twoPairs();
    feed('You have removed padded gloves.');
    expect(gloves(tracker).map((item) => item.equipped)).toEqual([false, false]);
    feed('You are now wearing padded gloves.');
    expect(gloves(tracker).map((item) => item.equipped)).toEqual([true, false]);
  });

  it('buys a second one as a second row', () => {
    const { tracker, feed } = twoPairs();
    feed('You just bought padded gloves for 0 copper farthings.');
    expect(gloves(tracker)).toHaveLength(3);
  });

  /* The replay across a listing counts too: a listing that predates a
     counted drop must lose that many. */
  it('replays a counted change that landed inside a listing', () => {
    const { tracker, feed } = twoPairs();
    feed('[HP=34]:');
    feed('You are carrying padded helm (Head), padded gloves (Hands), padded pants');
    feed('(Legs), padded boots (Feet), quarterstaff (Weapon Hand), padded gloves');
    feed('You dropped 2 padded gloves.');
    feed('You have no keys.');
    feed('Wealth: 0 copper farthings');
    feed('[HP=34]:');
    expect(gloves(tracker)).toEqual([]);
  });

  /* A listing replaces it outright, which is what makes the approximation safe. */
  it('is overruled by the next listing', () => {
    const { tracker, feed } = carrying();
    feed('You took a healing potion.');
    feed('You are carrying a shield.');
    feed('You have no keys.');
    feed('Wealth: 40 copper farthings');
    feed('[HP=33]:');
    expect(held(tracker)).toEqual(['a shield']);
  });
});

/*
 * Whether this character is moving unseen, which is what decides whether the
 * things in the next room notice it arrive. Parsed since phase 3 and read by
 * nothing until now.
 */
describe('moving unseen', () => {
  const feeder = (): { tracker: CharacterTracker; feed: (text: string) => void } => {
    const classifier = new Classifier();
    const tracker = new CharacterTracker();
    let seq = 0;
    const feed = (text: string): void => {
      seq += 1;
      const { block, batch } = classifier.classify({
        seq,
        at: 1_700_000_000_000 + seq,
        text,
        plain: text,
        terminator: 'newline'
      });
      tracker.apply(block);
      if (batch) tracker.apply(batch, batch.rows);
    };
    return { tracker, feed };
  };

  it('starts not knowing, which is not the same as being seen', () => {
    const { tracker, feed } = feeder();
    feed('[HP=33]:');
    expect(tracker.current.stealth).toBe('unknown');
  });

  it('is sneaking once the server says so', () => {
    const { tracker, feed } = feeder();
    feed('[HP=33]:');
    feed('Sneaking...');
    expect(tracker.current.stealth).toBe('sneaking');
  });

  /*
   * Attempting is not succeeding. Treating the attempt as the outcome is how a
   * rule comes to believe a character is hidden while it is walking into a lair
   * in plain sight.
   */
  it('does not call an attempt a success', () => {
    const { tracker, feed } = feeder();
    feed('[HP=33]:');
    feed('Attempting to sneak...');
    expect(tracker.current.stealth).toBe('unknown');
  });

  it('is seen when it makes a sound, fails, or cannot', () => {
    for (const line of [
      'You make a sound as you enter the room!',
      "Attempting to sneak...You don't think you're sneaking.",
      'You may not sneak right now!'
    ]) {
      const { tracker, feed } = feeder();
      feed('[HP=33]:');
      feed('Sneaking...');
      feed(line);
      expect(tracker.current.stealth, line).toBe('seen');
    }
  });

  /* Nobody is sneaking through a closed socket, and "seen" would be a claim
     about a realm this character is no longer in. */
  it('forgets it on leaving the realm', () => {
    const { tracker, feed } = feeder();
    feed('[HP=33]:');
    feed('Sneaking...');
    tracker.leaveRealm();
    expect(tracker.current.stealth).toBe('unknown');
  });
});

/* A bare encumbrance line arrives on its own, not only inside an `i` listing. */
describe('how much is being carried', () => {
  it('reads a line that arrives on its own', () => {
    const classifier = new Classifier();
    const tracker = new CharacterTracker();
    let seq = 0;
    for (const text of ['[HP=33]:', 'Encumbrance: 120/2400 - Light [5%]']) {
      seq += 1;
      const { block } = classifier.classify({
        seq,
        at: 1_700_000_000_000 + seq,
        text,
        plain: text,
        terminator: 'newline'
      });
      tracker.apply(block);
    }
    expect(tracker.current.inventory.encumbrance).toBe(120);
    expect(tracker.current.inventory.encumbranceMax).toBe(2400);
  });
});

/**
 * A lore that answers from a table and records what it is told.
 *
 * The whole point of `MobLore` being an interface: the parse path asks a
 * question, and what answers it here is a `Map` rather than a realm file and a
 * write schedule. §1 dependency inversion, in the one place in this codebase
 * where reaching for a database handle would recreate the per-line query
 * docs/legacy-assessment.md §5 records as the CoffeeScript engine's worst
 * mistake.
 */
function testLore(known: Record<string, number> = {}): MobLore & {
  entries: Map<string, MobLoreEntry>;
} {
  const entries = new Map<string, MobLoreEntry>();
  return {
    // The slot half is somebody else's test; this lore knows nothing about it.
    ...NO_LORE,
    entries,
    learnedFor: () => null,
    maximumFor: (name) => {
      const realm = known[name];
      if (realm !== undefined) return { max: realm, source: 'realm', span: null };
      const max = loreMaximum(entries.get(name));
      return max === null
        ? { max: null, source: null, span: null }
        : { max, source: 'learned', span: null };
    },
    observe: (name, outcome) => {
      entries.set(name, learn(entries.get(name), outcome));
    }
  };
}

/**
 * How the thing on the other end of the fight is holding up.
 *
 * The server never states a monster's health — not in a status line, not on a
 * hit, not on a death. So everything here is a maximum from somewhere else
 * minus the damage lines the stream carries, and the tests that matter are the
 * ones about what happens when there is no maximum and when the arithmetic has
 * drifted away from the truth.
 */
describe('how the target is holding up', () => {
  const engage = (...lines: string[]): string[] => [
    '[HP=98/MA=50]:',
    'Name: Vaelor    Lives/CP: 3/12',
    '*Combat Engaged*',
    ...lines
  ];

  it('draws a bar against what the realm data says', () => {
    const tracker = play(
      engage('You slash the giant rat for 4 damage!'),
      undefined,
      testLore({ 'giant rat': 12 })
    );
    const health = tracker.current.combat.health;
    expect(health?.max).toBe(12);
    expect(health?.source).toBe('realm');
    expect(health?.remaining).toBeCloseTo(8 / 12);
    expect(health?.damage).toEqual({ mine: 4, others: 0 });
  });

  /*
   * The common case on any realm this client does not ship. A tally and a
   * split are still worth having; a bar drawn against a maximum nobody knows
   * is the lie that gets a character killed.
   */
  it('gives an unknown monster a tally and no bar', () => {
    const tracker = play(engage('You slash the thing for 40 damage!'), undefined, testLore());
    const health = tracker.current.combat.health;
    expect(health?.name).toBe('thing');
    expect(health?.max).toBeNull();
    expect(health?.source).toBeNull();
    expect(health?.remaining).toBeNull();
    expect(health?.damage.mine).toBe(40);
  });

  /*
   * A fight four people are in is a different fight. This used to be discarded
   * outright, so the bar showed a monster at full health seconds before it fell
   * over.
   */
  it('counts everybody else’s damage, separately from its own', () => {
    const tracker = play(
      engage('You slash the giant rat for 3 damage!', 'Borin cleaves the giant rat for 5 damage!'),
      undefined,
      testLore({ 'giant rat': 12 })
    );
    expect(tracker.current.combat.health?.damage).toEqual({ mine: 3, others: 5 });
    expect(tracker.current.combat.health?.remaining).toBeCloseTo(4 / 12);
  });

  /*
   * …and must not let it become *this* character's fight. A rule that swings at
   * `{target}` handed the name of something a stranger is fighting starts a
   * second fight in a room already holding one.
   */
  it('never lets somebody else’s swing name this character’s target', () => {
    const tracker = play(
      engage('Borin cleaves the giant rat for 5 damage!'),
      undefined,
      testLore({ 'giant rat': 12 })
    );
    expect(tracker.current.combat.target).toBeNull();
    expect(tracker.current.combat.health).toBeNull();
  });

  /* One monster's blows must not be charged to another's bar. */
  it('keeps a ledger per monster, not per fight', () => {
    const tracker = play(
      engage(
        'You slash the giant rat for 4 damage!',
        'You slash the giant rat for 2 damage!',
        'You slash the lashworm for 6 damage!'
      ),
      undefined,
      testLore({ 'giant rat': 12, lashworm: 15 })
    );
    // The bar follows the target, and carries only that monster's six.
    expect(tracker.current.combat.target).toBe('lashworm');
    expect(tracker.current.combat.health?.damage.mine).toBe(6);
    expect(tracker.current.combat.health?.remaining).toBeCloseTo(9 / 15);
  });

  /* `The giant rat` and `giant rat` are one monster, not two. */
  it('treats the article as spelling, not identity', () => {
    const tracker = play(
      engage('You slash the giant rat for 4 damage!', 'Borin hits giant rat for 3 damage!'),
      undefined,
      testLore({ 'giant rat': 12 })
    );
    expect(tracker.current.combat.health?.damage).toEqual({ mine: 4, others: 3 });
  });
});

/**
 * `look <mob>` is the only statement of a monster's health this server makes,
 * and the sentence it makes it in names nothing: `He appears to be severely
 * wounded.` So the binding is the command it answers, and getting that wrong
 * puts one monster's condition on another's bar.
 */
describe('re-anchoring an estimate from a look', () => {
  const engage = (...steps: Step[]): Step[] => [
    '[HP=98/MA=50]:',
    'Name: Vaelor    Lives/CP: 3/12',
    '*Combat Engaged*',
    ...steps
  ];

  it('pulls an estimate back up when the monster has healed', () => {
    /*
     * The regeneration case. Mobs heal on a server tick and nothing announces
     * it, so an estimate built from damage alone only falls — here to 1/12 —
     * while the server reports the monster is over half.
     */
    const tracker = play(
      engage(
        'You slash the giant rat for 11 damage!',
        { send: 'look giant rat' },
        'giant rat',
        'A mangy thing with too many teeth.',
        'He appears to be heavily wounded.'
      ),
      undefined,
      testLore({ 'giant rat': 12 })
    );
    const health = tracker.current.combat.health;
    expect(health?.observed).toBe('heavily wounded');
    expect(health?.remaining).toBeCloseTo(0.5);
  });

  /* Damage after the look continues from the corrected figure, not from zero. */
  it('carries on from the corrected figure', () => {
    const tracker = play(
      engage(
        'You slash the giant rat for 11 damage!',
        { send: 'look giant rat' },
        'He appears to be heavily wounded.',
        'You slash the giant rat for 3 damage!'
      ),
      undefined,
      testLore({ 'giant rat': 12 })
    );
    expect(tracker.current.combat.health?.remaining).toBeCloseTo(0.5 - 3 / 12);
  });

  /*
   * The failure the binding exists to prevent: a player who looked at the other
   * monster in the room, shown its condition on the bar of the one they are
   * fighting — wrong in the reassuring direction.
   */
  it('never puts one monster’s condition on another’s bar', () => {
    const tracker = play(
      engage(
        'You slash the giant rat for 11 damage!',
        { send: 'look lashworm' },
        'He appears to be unwounded.'
      ),
      undefined,
      testLore({ 'giant rat': 12, lashworm: 15 })
    );
    expect(tracker.current.combat.health?.observed).toBeNull();
    expect(tracker.current.combat.health?.remaining).toBeCloseTo(1 / 12);
  });

  /* A wound line with no look behind it describes nothing this client can name. */
  it('drops a wound line it cannot bind', () => {
    const tracker = play(
      engage('You slash the giant rat for 11 damage!', 'He appears to be unwounded.'),
      undefined,
      testLore({ 'giant rat': 12 })
    );
    expect(tracker.current.combat.health?.observed).toBeNull();
  });

  /*
   * The abbreviation case, and the one that was actually on screen: `l du`
   * against the arena's practice dummy. The server resolves an argument as a
   * prefix — that is why players type that way — so a band filed under the
   * typed text lands on a ledger no blow ever touches, and the card kept
   * showing `0/32000 CRITICAL` while the same screen said *slightly wounded*.
   */
  it('binds a look through the abbreviation the player typed', () => {
    const tracker = play(
      [
        '[HP=98/MA=50]:',
        'Also here: practice dummy.',
        'Obvious exits: north',
        '*Combat Engaged*',
        'You punch practice dummy for 11 damage!',
        { send: 'l du' },
        'He appears to be slightly wounded.'
      ],
      undefined,
      testLore({ 'practice dummy': 12 })
    );
    const health = tracker.current.combat.health;
    expect(health?.observed).toBe('slightly wounded');
    expect(health?.remaining).toBeCloseTo(0.85);
  });

  /*
   * A monster's name modifier is a word hung on the front, and a look answers
   * to the base name the same way an attack does.
   */
  it('binds a look through a name modifier', () => {
    const tracker = play(
      [
        '[HP=98/MA=50]:',
        'Also here: small giant rat.',
        'Obvious exits: north',
        '*Combat Engaged*',
        'You slash the small giant rat for 11 damage!',
        { send: 'look giant rat' },
        'He appears to be heavily wounded.'
      ],
      undefined,
      testLore({ 'small giant rat': 12 })
    );
    expect(tracker.current.combat.health?.observed).toBe('heavily wounded');
  });

  /*
   * The typed text may span a word boundary: `Misc.IsMatch` boundary-checks
   * only where the match *starts*, never where it ends. A rule that split the
   * name into words and tested each would refuse this, and the server does not.
   */
  it('binds a look through an abbreviation that spans a space', () => {
    const tracker = play(
      [
        '[HP=98/MA=50]:',
        'Also here: practice dummy.',
        'Obvious exits: north',
        '*Combat Engaged*',
        'You punch practice dummy for 11 damage!',
        { send: 'l practice du' },
        'It appears to be slightly wounded.'
      ],
      undefined,
      testLore({ 'practice dummy': 12 })
    );
    expect(tracker.current.combat.health?.observed).toBe('slightly wounded');
  });

  /*
   * A match that starts mid-word is not a match. `ummy` reaches nothing, so the
   * band is filed against the typed text and never lands on the dummy's bar —
   * the refusing direction, which is the safe one.
   */
  it('refuses a match that starts inside a word', () => {
    const tracker = play(
      [
        '[HP=98/MA=50]:',
        'Also here: practice dummy.',
        'Obvious exits: north',
        '*Combat Engaged*',
        'You punch practice dummy for 11 damage!',
        { send: 'l ummy' },
        'It appears to be unwounded.'
      ],
      undefined,
      testLore({ 'practice dummy': 12 })
    );
    expect(tracker.current.combat.health?.observed).toBeNull();
  });

  /*
   * An exact name wins outright over a boundary match, and not merely by being
   * first in the list. The server compares `==` across every candidate and
   * *clears* what it had accumulated on a hit, so a room holding both `rat` and
   * `giant rat` resolves a typed `rat` to `rat` — even though `giant rat` is
   * listed first and matches the boundary rule at its second word.
   */
  it('prefers an exact name over a boundary match listed before it', () => {
    const tracker = play(
      [
        '[HP=98/MA=50]:',
        'Also here: giant rat, rat.',
        'Obvious exits: north',
        '*Combat Engaged*',
        'You slash rat for 3 damage!',
        { send: 'l rat' },
        'He appears to be heavily wounded.'
      ],
      undefined,
      testLore({ rat: 12, 'giant rat': 40 })
    );
    const health = tracker.current.combat.health;
    expect(health?.name).toBe('rat');
    expect(health?.observed).toBe('heavily wounded');
  });

  /*
   * The look is bound to the room it was *asked* in, not the room its answer
   * arrives in. A re-read can land between the two — the `refreshRounds`
   * backstop exists to make that happen — and resolving late would pin the band
   * onto whatever now answers to those letters. Here `du` means the dummy when
   * it is typed; by the time the sentence arrives the dummy is gone and a
   * `dune wolf` answers to `du` instead. The band must still be the dummy's.
   */
  it('binds a look to the room it was asked in, not the one that answers', () => {
    const tracker = play(
      [
        '[HP=98/MA=50]:',
        'Also here: practice dummy.',
        'Obvious exits: north',
        '*Combat Engaged*',
        'You punch practice dummy for 11 damage!',
        { send: 'l du' },
        // The room is re-read before the answer comes back, and it has changed.
        'Arena Practice Room',
        'Also here: dune wolf.',
        'Obvious exits: north',
        'It appears to be slightly wounded.'
      ],
      undefined,
      testLore({ 'practice dummy': 12, 'dune wolf': 30 })
    );
    const health = tracker.current.combat.health;
    expect(health?.name).toBe('practice dummy');
    expect(health?.observed).toBe('slightly wounded');
  });

  /*
   * A refused look answers nothing, so its queue entry has to go with it.
   * Left behind, the *next* wound sentence — about a different monster, in a
   * different room — binds to it. Both refusals take this path; the server
   * ships three spellings of the first and only one was ever matched.
   */
  it.each([
    ['You do not see du here!', 'the LookCommand spelling'],
    ["You don't see du here!", 'the exclamation spelling'],
    ["You don't see du here.", 'the captured spelling'],
    ['Please be more specific.  You could have meant any of these:', 'the ambiguity refusal']
  ])('drops a look the server refused with %s', (refusal, _what) => {
    /*
     * Two looks go out. The first is refused, so no sentence answers it; the
     * second is answered. Left in the queue, the refused look would consume
     * the *second* look's sentence — and the band the player asked about the
     * rat would be filed against the dummy, which is exactly the wrong-monster
     * failure the queue exists to prevent.
     */
    const tracker = play(
      [
        '[HP=98/MA=50]:',
        'Also here: practice dummy, giant rat.',
        'Obvious exits: north',
        '*Combat Engaged*',
        'You slash the giant rat for 3 damage!',
        { send: 'l du' },
        refusal,
        { send: 'l giant rat' },
        'He appears to be heavily wounded.'
      ],
      undefined,
      testLore({ 'practice dummy': 12, 'giant rat': 12 })
    );
    const health = tracker.current.combat.health;
    // The rat is what was engaged, and the band that arrived is the rat's.
    expect(health?.name).toBe('giant rat');
    expect(health?.observed).toBe('heavily wounded');
  });

  /*
   * `LookCommand` collapses an ambiguity by kind: exactly one matching player
   * beats any number of matching monsters. A look at a *player* prints no wound
   * sentence, so binding the monster here would leave the queue holding an
   * entry that the next unrelated wound line would answer.
   */
  it('does not bind a monster when the server would have looked at a player', () => {
    const tracker = play(
      [
        '[HP=98/MA=50]:',
        // The roster is what makes Ratface a person rather than an unknown:
        // capitalisation alone is deliberately not enough.
        '         Current Adventurers',
        '         ===================',
        '         Ratface               -  Apprentice',
        '[HP=98/MA=50]:',
        'Also here: Ratface, giant rat.',
        'Obvious exits: north',
        '*Combat Engaged*',
        'You slash the giant rat for 3 damage!',
        // Both `Ratface` and `giant rat` answer to `rat`, and the player wins
        // outright — so the server looks at Ratface and says nothing about a
        // wound. Exactly one monster matches too, which is what makes this
        // test discriminating: without the player branch the rat is bound.
        { send: 'l rat' },
        'He appears to be unwounded.'
      ],
      undefined,
      testLore({ 'giant rat': 12 })
    );
    expect(tracker.current.combat.health?.observed).toBeNull();
  });

  /* Walking away invalidates an unanswered look: that room is behind you. */
  it('forgets an unanswered look once the character moves', () => {
    const tracker = play(
      engage(
        'You slash the giant rat for 11 damage!',
        { send: 'look giant rat' },
        { send: 'n' },
        'He appears to be unwounded.'
      ),
      undefined,
      testLore({ 'giant rat': 12 })
    );
    expect(tracker.current.combat.health?.observed).toBeNull();
  });
});

/**
 * What a fight teaches, and the two ways it could teach something false.
 *
 * The death sentence itself is realm data (`MobType.DeathMessage`), so there is
 * no phrase to match on that survives the next realm — experience is the
 * nearest thing to an announcement, and it is not exact.
 */
describe('learning a monster’s health by fighting it', () => {
  const engage = (...lines: string[]): string[] => [
    '[HP=98/MA=50]:',
    'Name: Vaelor    Lives/CP: 3/12',
    '*Combat Engaged*',
    ...lines
  ];

  it('records the total it took to kill, once the fight is over', () => {
    const lore = testLore();
    play(
      engage(
        'You slash the thing for 40 damage!',
        'Borin cleaves the thing for 25 damage!',
        'You gain 300 experience.',
        '*Combat Off*'
      ),
      undefined,
      lore
    );
    expect(lore.entries.get('thing')?.kill).toBe(65);
    expect(lore.entries.get('thing')?.kills).toBe(1);
  });

  /*
   * A party member's kill credits this character with experience too. Charging
   * that to whatever this character happened to be swinging at would record a
   * live monster's part-total as what it took to kill it — permanently, because
   * the estimator is a minimum. A monster that goes on taking blows did not die.
   */
  it('drops a suspected death the next blow disproves', () => {
    const lore = testLore();
    play(
      engage(
        'You slash the thing for 40 damage!',
        'You gain 300 experience.',
        'You slash the thing for 30 damage!',
        '*Combat Off*'
      ),
      undefined,
      lore
    );
    expect(lore.entries.get('thing')?.kill).toBeNull();
    // Still a floor: it absorbed 70 and was standing when the fight ended.
    expect(lore.entries.get('thing')?.survived).toBe(70);
  });

  /*
   * Walking in on somebody else's fight and landing the last blow yields a
   * total far below the monster's real health — and a minimum estimator keeps
   * an undercount for good. The first blow being somebody else's is the one
   * signal available that there was a fight before this client was watching.
   */
  it('refuses to learn a kill from a fight it did not see the start of', () => {
    const lore = testLore();
    play(
      engage(
        'Borin cleaves the thing for 5 damage!',
        'You slash the thing for 3 damage!',
        'You gain 300 experience.',
        '*Combat Off*'
      ),
      undefined,
      lore
    );
    // Nothing at all, rather than a low number written down as the answer.
    expect(lore.entries.get('thing')).toBeUndefined();
  });

  it('records what a monster survived as a floor under its health', () => {
    const lore = testLore();
    play(engage('You slash the thing for 90 damage!', '*Combat Off*'), undefined, lore);
    expect(lore.entries.get('thing')).toEqual(
      expect.objectContaining({ kill: null, survived: 90 })
    );
  });

  /* A socket that closed mid-fight says nothing about whether anything lived. */
  it('learns nothing from a fight a disconnection ended', () => {
    const lore = testLore();
    const tracker = play(engage('You slash the thing for 90 damage!'), undefined, lore);
    tracker.leaveRealm();
    expect(lore.entries.size).toBe(0);
  });
});

/*
 * What the client learns when the realm disagrees with the data it shipped.
 *
 * The whole value of this is in what it *refuses* to write down: a record kept
 * against a character is only worth having if everything in it is a fact, and
 * the ordinary case — a known room, a known exit, a known destination — is the
 * overwhelming majority of every walk.
 */
describe('learning what the realm data does not have', () => {
  const CLIFF = { m: 1, r: 10, n: 'Cliff Top', x: { n: { m: 1, r: 11 } } };
  const NORTH = { m: 1, r: 11, n: 'North Meadow', x: { s: { m: 1, r: 10 } } };
  /** Reachable in the data from nowhere: the ledge is a room with no way in. */
  const LEDGE = { m: 1, r: 12, n: 'Narrow Ledge', x: { u: { m: 1, r: 10 } } };

  function learningWorld(): WorldGraph {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-memory-'));
    const file = path.join(dir, 'rooms.jsonl.gz');
    const header = JSON.stringify({ v: 1, source: 'test', rooms: 3, generatedAt: 'x' });
    fs.writeFileSync(
      file,
      zlib.gzipSync(
        [header, JSON.stringify(CLIFF), JSON.stringify(NORTH), JSON.stringify(LEDGE)].join('\n') +
          '\n'
      )
    );
    const graph = WorldGraph.load(file);
    fs.rmSync(dir, { recursive: true, force: true });
    return graph;
  }

  /** A tracker that records what it learns, so a test can read it back. */
  function learner(): {
    tracker: CharacterTracker;
    found: Discovery[];
    feed: (lines: string[]) => void;
    send: (command: string) => void;
  } {
    const classifier = new Classifier();
    const found: Discovery[] = [];
    const tracker = new CharacterTracker(learningWorld(), undefined, (discovery) =>
      found.push(discovery)
    );
    let seq = 0;
    const feed = (lines: string[]): void => {
      for (const plain of lines) {
        seq += 1;
        const line: StreamLine = {
          seq,
          at: 1_700_000_000_000 + seq,
          text: plain,
          plain,
          terminator: 'newline'
        };
        const { block, batch } = classifier.classify(line);
        tracker.apply(block);
        if (batch) tracker.apply(batch);
      }
    };
    const send = (command: string): void => {
      tracker.observeCommand(command);
      classifier.observeCommand(command);
    };
    /*
     * In the realm before anything else. Nothing typed at a login menu can be a
     * way through the realm, and one of the things typed there is a password —
     * so the tracker only holds an unmodelled command while the status line
     * says the character is playing.
     */
    feed(['[HP=100]: ']);
    return { tracker, found, feed, send };
  }

  const AT_CLIFF = ['Cliff Top', 'Obvious exits: north'];
  const AT_NORTH = ['North Meadow', 'Obvious exits: south'];
  const AT_LEDGE = ['Narrow Ledge', 'Obvious exits: up'];

  it('says nothing about an ordinary step the data already has', () => {
    const { found, feed, send } = learner();
    feed(['Location:            1,10', ...AT_CLIFF]);
    send('n');
    feed(AT_NORTH);
    expect(found).toEqual([]);
  });

  /*
   * The example this exists for: a text exit, which is room data rather than a
   * command, and therefore has no entry in the server's command table
   * (`shared/commands.ts`). That absence is the whole test — `climb cliff`
   * reaches this because nothing in `Commands.cs` claims the word `climb`.
   *
   * `jump cliff` reads more naturally and is the wrong example: `jump` **is**
   * in the table, as `Jumpkick`, so typing it aims a kick at something called
   * cliff rather than going anywhere. Losing that one is the safe direction to
   * be wrong in — a missed discovery, rather than a route written into a
   * permanent file that nobody can walk.
   */
  it('learns a text exit the realm data does not have', () => {
    const { found, feed, send } = learner();
    feed(['Location:            1,10', ...AT_CLIFF]);
    send('climb cliff');
    feed(AT_LEDGE);

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      reason: 'unknown-exit',
      from: '1/10',
      fromName: 'Cliff Top',
      command: 'climb cliff',
      to: '1/12',
      name: 'Narrow Ledge'
    });
  });

  /*
   * The failure this replaced. Both of these went into a real character's
   * permanent record in one evening, and neither is a way through anything.
   */
  it('learns nothing from a command the realm cannot move anybody with', () => {
    const { found, feed, send } = learner();
    feed(['Location:            1,10', ...AT_CLIFF]);
    // `l` reprints the room you are standing in, so the room that arrives is
    // the room you were already in — which taught the client that looking
    // leads from a room to itself.
    send('l');
    feed(AT_LEDGE);
    expect(found).toEqual([]);
  });

  it('learns nothing from a `sys` teleport', () => {
    const { found, feed, send } = learner();
    feed(['Location:            1,10', ...AT_CLIFF]);
    // `sys go 1 12` really does move the character — along no edge, by room
    // number, and only for somebody who has the command.
    send('sys go 1 12');
    feed(AT_LEDGE);
    expect(found).toEqual([]);
  });

  it('learns a compass exit the data does not have', () => {
    const { found, feed, send } = learner();
    feed(['Location:            1,10', ...AT_CLIFF]);
    // The data says Cliff Top goes north and nowhere else.
    send('d');
    feed(AT_LEDGE);
    expect(found[0]).toMatchObject({ reason: 'unknown-exit', command: 'd', to: '1/12' });
  });

  it('learns a room the realm data does not have at all, and keeps its exits', () => {
    const { found, feed, send } = learner();
    feed(['Location:            1,10', ...AT_CLIFF]);
    send('ne');
    feed(['Hidden Hollow', 'Obvious exits: south, west']);

    expect(found[0]).toMatchObject({
      reason: 'unknown-room',
      from: '1/10',
      command: 'ne',
      to: null,
      name: 'Hidden Hollow'
    });
    // The exits are the only description of a room the data does not have, so
    // they are the part worth keeping.
    expect(found[0]?.exits).toEqual(['s', 'w']);
  });

  it('says nothing when it does not know where it was standing', () => {
    // An edge from nowhere is not an edge, and writing one down against a
    // character would be a permanent record of a guess. Starting in a room the
    // realm data does not have is the honest version of "we do not know": the
    // client has a name and no coordinates, and nothing moved it there.
    const { tracker, found, feed, send } = learner();
    feed(['Hidden Hollow', 'Obvious exits: south']);
    expect(tracker.current.room.map).toBeNull();
    send('jump cliff');
    feed(AT_LEDGE);
    expect(found).toEqual([]);
  });

  /*
   * The reported failure, replayed from the transcript that produced it.
   *
   *     nw
   *     The small baby green dragon breathes a cloud of poison on you for 91 damage!
   *     You drop to the ground!
   *     You have been killed!
   *     But, due to a miracle, you have been saved.
   *     You have 41 lives left.
   *     Temple, Halls of the Dead
   *     Obvious exits: up
   *     │ Learned: "nw" leads from Darkwood Forest to Temple, Halls of the Dead.
   *
   * That line went into a permanent per-character file and would have been
   * offered to every route planned afterwards. A death is a teleport with no
   * destination in it: the realm moves the character, and the move that was
   * outstanding is about a room that will never arrive.
   */
  it('learns nothing from the room a death moved the character to', () => {
    const { found, feed, send } = learner();
    feed(['Location:            1,10', ...AT_CLIFF]);
    send('d');
    feed(['You drop to the ground!', 'You have been killed!']);
    feed(['But, due to a miracle, you have been saved.', 'You have 41 lives left.']);
    feed(AT_LEDGE);
    expect(found).toEqual([]);
  });

  /*
   * The positive control for the assertion above. `d` from Cliff Top to Narrow
   * Ledge is an edge the realm data does not have, and it *is* learned — so the
   * empty list above is the death being read, not the transcript failing to
   * reach the learner at all.
   */
  it('learns the same step when nothing killed the character', () => {
    const { found, feed, send } = learner();
    feed(['Location:            1,10', ...AT_CLIFF]);
    send('d');
    feed(AT_LEDGE);
    expect(found[0]).toMatchObject({ reason: 'unknown-exit', command: 'd' });
  });

  /*
   * And the count the server states while it is at it. The stat sheet's
   * `Lives/CP:` establishes the figure; this keeps it true without a command.
   */
  it('reads the lives left off the death itself', () => {
    const { tracker, feed } = learner();
    feed(['You have been killed!', 'You have 41 lives left.']);
    expect(tracker.current.progress.lives).toBe(41);
  });

  it('says nothing when nothing was typed', () => {
    // A room can arrive because somebody else opened a door. That is not a way
    // this character found.
    const { found, feed } = learner();
    feed(['Location:            1,10', ...AT_CLIFF, ...AT_LEDGE]);
    expect(found).toEqual([]);
  });

  it('attributes nothing when two commands went out before the room came back', () => {
    const { found, feed, send } = learner();
    feed(['Location:            1,10', ...AT_CLIFF]);
    send('pull lever');
    send('climb cliff');
    feed(AT_LEDGE);
    // One slot, deliberately: which of the two moved the character is a
    // question nobody can answer, and the record only holds answers.
    expect(found).toEqual([{ ...found[0], command: 'climb cliff' }]);
  });

  it('does not attribute a queued direction to the command before it', () => {
    const { found, feed, send } = learner();
    feed(['Location:            1,10', ...AT_CLIFF]);
    send('st');
    send('n');
    feed(AT_NORTH);
    expect(found).toEqual([]);
  });

  it('holds nothing typed before the character is in the realm', () => {
    // One of the things typed at a login menu is a password, and this file is
    // written to disk and read back next launch.
    const classifier = new Classifier();
    const found: Discovery[] = [];
    const tracker = new CharacterTracker(learningWorld(), undefined, (d) => found.push(d));
    let seq = 0;
    const feed = (lines: string[]): void => {
      for (const plain of lines) {
        seq += 1;
        const { block } = classifier.classify({
          seq,
          at: 1_700_000_000_000 + seq,
          text: plain,
          plain,
          terminator: 'newline'
        });
        tracker.apply(block);
      }
    };

    feed(['Please enter your password: ']);
    tracker.observeCommand('hunter2');
    feed(['Location:            1,10', ...AT_CLIFF, '[HP=100]: ']);
    feed(AT_LEDGE);
    expect(found).toEqual([]);
  });

  it('says nothing about a look that did not move anybody', () => {
    const { found, feed, send } = learner();
    feed(['Location:            1,10', ...AT_CLIFF]);
    send('l');
    feed(AT_CLIFF);
    expect(found).toEqual([]);
  });
});

/*
 * The shop half of the realm memory.
 *
 * Answerable *without* a capture of the `list` output, which is what had
 * blocked it: the buying sentence is already parsed, the room already resolves,
 * and the realm data already says which shop the room holds and what it stocks.
 */
describe('learning what a shop stocks that the realm data does not', () => {
  const MARKET = { m: 1, r: 20, n: 'Market Square', x: {}, s: 4 };
  /** A room whose shop the realm data has no stock for. */
  const BACKSTREET = { m: 1, r: 21, n: 'Backstreet Stall', x: {}, s: 9 };
  const PLAIN = { m: 1, r: 22, n: 'Empty Lot', x: {} };

  function shopWorld(): WorldGraph {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-shopmem-'));
    const file = path.join(dir, 'rooms.jsonl.gz');
    const header = JSON.stringify({
      v: 4,
      source: 'test',
      rooms: 3,
      generatedAt: 'x',
      items: [{ id: 12, n: 'lantern' }],
      shops: [{ id: 4, n: 'General Store', items: [12] }]
    });
    fs.writeFileSync(
      file,
      zlib.gzipSync(
        [header, JSON.stringify(MARKET), JSON.stringify(BACKSTREET), JSON.stringify(PLAIN)].join(
          '\n'
        ) + '\n'
      )
    );
    const graph = WorldGraph.load(file);
    fs.rmSync(dir, { recursive: true, force: true });
    return graph;
  }

  function shopper(): { found: Discovery[]; feed: (lines: string[]) => void } {
    const classifier = new Classifier();
    const found: Discovery[] = [];
    const tracker = new CharacterTracker(shopWorld(), undefined, (d) => found.push(d));
    let seq = 0;
    const feed = (lines: string[]): void => {
      for (const plain of lines) {
        seq += 1;
        const { block, batch } = classifier.classify({
          seq,
          at: 1_700_000_000_000 + seq,
          text: plain,
          plain,
          terminator: 'newline'
        });
        tracker.apply(block);
        if (batch) tracker.apply(batch);
      }
    };
    feed(['[HP=100]: ']);
    return { found, feed };
  }

  const IN_MARKET = ['Location:            1,20', 'Market Square', 'Obvious exits: north'];

  it('says nothing when the shop is selling what the realm says it sells', () => {
    const { found, feed } = shopper();
    feed([...IN_MARKET, 'You just bought lantern for 4 copper farthings.']);
    expect(found).toEqual([]);
  });

  it('writes down something the realm data does not list the shop as stocking', () => {
    const { found, feed } = shopper();
    feed([...IN_MARKET, 'You just bought brass lantern for 9 copper farthings.']);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      reason: 'unknown-stock',
      from: '1/20',
      fromName: 'General Store',
      name: 'brass lantern',
      to: null
    });
  });

  /*
   * No stock recorded is not "stocks nothing": it is a shop the realm data
   * cannot speak for, and every purchase there would otherwise be a finding.
   */
  it('says nothing in a shop the realm data has no stock for', () => {
    const { found, feed } = shopper();
    feed([
      'Location:            1,21',
      'Backstreet Stall',
      'Obvious exits: north',
      'You just bought anything at all for 1 copper farthings.'
    ]);
    expect(found).toEqual([]);
  });

  it('says nothing in a room that is not a shop', () => {
    const { found, feed } = shopper();
    feed([
      'Location:            1,22',
      'Empty Lot',
      'Obvious exits: north',
      'You just bought a rumour for 1 copper farthings.'
    ]);
    expect(found).toEqual([]);
  });

  /* Compared the way items are compared everywhere else, so an article cannot
     make a listed item look unlisted. */
  it('matches the listing however the article is spelled', () => {
    const { found, feed } = shopper();
    feed([...IN_MARKET, 'You just bought a lantern for 4 copper farthings.']);
    expect(found).toEqual([]);
  });
});

/*
 * A shop trip, and what the pack looks like afterwards.
 *
 * Captured from the live realm, where a starter shop sells and buys back for
 * nothing:
 *
 *     [HP=34]:bu quar
 *     You just bought quarterstaff for 0 copper farthings.
 *     [HP=34]:sell qua
 *     You sold quarterstaff for 0 copper farthings.
 */
describe('buying and selling move an item without asking again', () => {
  const feeder = () => {
    const classifier = new Classifier();
    const tracker = new CharacterTracker();
    let seq = 0;
    const feed = (text: string): void => {
      seq += 1;
      const { block, batch } = classifier.classify({
        seq,
        at: 1_700_000_000_000 + seq,
        text,
        plain: text,
        terminator: 'newline'
      });
      tracker.apply(block);
      if (batch) tracker.apply(batch, batch.rows);
    };
    return { tracker, feed };
  };

  it('adds what was bought', () => {
    const { tracker, feed } = feeder();
    feed('You just bought quarterstaff for 0 copper farthings.');
    expect(tracker.current.inventory.items.map((i) => i.name)).toContain('quarterstaff');
  });

  it('removes what was sold', () => {
    const { tracker, feed } = feeder();
    feed('You just bought quarterstaff for 0 copper farthings.');
    feed('You sold quarterstaff for 0 copper farthings.');
    expect(tracker.current.inventory.items).toEqual([]);
  });

  /*
   * The shop has it, not the floor. Putting it in the room's list would show an
   * item in the room that nobody in the room can pick up — which is the
   * difference between selling and dropping.
   */
  it('does not leave what was sold lying on the floor', () => {
    const { tracker, feed } = feeder();
    feed('You just bought quarterstaff for 0 copper farthings.');
    feed('You sold quarterstaff for 0 copper farthings.');
    expect(tracker.current.room.items).toEqual([]);
  });

  it('sells something the listing wrote with its slot', () => {
    const { tracker, feed } = feeder();
    feed('[HP=34]:');
    feed('You are carrying quarterstaff (Weapon Hand)');
    feed('You have no keys.');
    feed('[HP=34]:');
    feed('You sold quarterstaff for 0 copper farthings.');
    expect(tracker.current.inventory.items).toEqual([]);
  });
});

/*
 * Banking: the vault states what it holds, and a round trip moves both figures.
 *
 * Captured live at the Bank of Godfrey (2026-08-29 and 2026-08-30):
 *
 *     [HP=334/KAI=27]:deposit 102351
 *     You deposit 102351 copper farthings.
 *     [HP=334/KAI=27]:bank
 *     Your balance at Bank of Godfrey is:
 *     On deposit: 310335 copper farthings [3,103.35 gold crowns]
 *     [HP=334/KAI=27]:You withdrew 20000 copper farthings.
 *
 * The last of those is one framed line carrying two facts — the server put no
 * repaint between the prompt and the sentence — which is why the feeder below
 * applies the classifier's `tail` as well as its block.
 *
 * And the same record on MajorMUD (captures/007:114), which spells the header
 * differently in both of the two ways it can:
 *
 *     Your balance at The Bank of Godfrey (#8) is:
 *     On deposit: 57137 copper farthings
 */
describe('a bank states what it holds, and only for itself', () => {
  const feeder = () => {
    const classifier = new Classifier();
    const tracker = new CharacterTracker();
    let seq = 0;
    const feed = (text: string): void => {
      seq += 1;
      const { block, batch, tails } = classifier.classify({
        seq,
        at: 1_700_000_000_000 + seq,
        text,
        plain: text,
        terminator: 'newline'
      });
      tracker.apply(block);
      if (batch) tracker.apply(batch, batch.rows);
      // The prompt first, then what the server printed after it — the order
      // `SessionManager.publishLine` uses, and the order the server wrote them.
      for (const tail of tails ?? []) tracker.apply(tail);
    };
    return { tracker, feed };
  };

  /*
   * The prompt is not decoration here. A batch closes on the status line — the
   * server having moved on is what says the record is whole — so a transcript
   * replayed without it leaves the batch open and nothing reaches the tracker.
   * Every capture has it; a test that omits it is testing a wire that does not
   * exist.
   */
  const balance = (feed: (t: string) => void, header: string, copper: string): void => {
    feed(header);
    feed(`On deposit: ${copper}`);
    feed('[HP=334/KAI=27]:');
  };

  const purse = (feed: (t: string) => void, copper: number): void => {
    feed('You are carrying sandals');
    feed('You have no keys.');
    feed(`Wealth: ${copper} copper farthings`);
    feed('Encumbrance: 868/4800 - Light [18%]');
    feed('[HP=334/KAI=27]:');
  };

  it('reads the balance the vault stated', () => {
    const { tracker, feed } = feeder();
    balance(
      feed,
      'Your balance at Bank of Godfrey is:',
      '310335 copper farthings [3,103.35 gold crowns]'
    );
    expect(tracker.current.banks).toEqual([
      { shop: null, name: 'Bank of Godfrey', copper: 310335, at: expect.any(Number) }
    ]);
  });

  /*
   * The bracketed figure is the server's own arithmetic over the same total,
   * exactly as `Wealth:` is over the five denominations. Keeping it would be a
   * second copy of one fact, and it is the *separated* one — reading it as the
   * balance would make 310335 into 3.
   */
  it('keeps the copper and never the conversion beside it', () => {
    const { tracker, feed } = feeder();
    balance(
      feed,
      'Your balance at Bank of Godfrey is:',
      '310335 copper farthings [3,103.35 gold crowns]'
    );
    expect(tracker.current.banks[0]?.copper).toBe(310_335);
  });

  /*
   * MajorMUD prints `The` and the realm's own shop id; GreaterMUD prints
   * neither. Left in the name, `(#8)` would make one vault into two.
   */
  it('lifts the shop id out of the name and drops the article', () => {
    const { tracker, feed } = feeder();
    balance(feed, 'Your balance at The Bank of Godfrey (#8) is:', '57137 copper farthings');
    expect(tracker.current.banks).toEqual([
      { shop: 8, name: 'Bank of Godfrey', copper: 57137, at: expect.any(Number) }
    ]);
  });

  /*
   * The inversion this state does not otherwise make. `bank` answers for the
   * vault the character is standing in and says nothing whatever about the
   * others, so replacing the list would empty a bank on the word of a command
   * that never mentioned it.
   */
  it('leaves every other bank alone', () => {
    const { tracker, feed } = feeder();
    balance(feed, 'Your balance at Bank of Godfrey is:', '310335 copper farthings');
    balance(feed, 'Your balance at Rhudaur Bank is:', '42 copper farthings');
    expect(tracker.current.banks.map((b) => [b.name, b.copper])).toEqual([
      ['Bank of Godfrey', 310_335],
      ['Rhudaur Bank', 42]
    ]);
  });

  it('replaces a vault\u2019s own figure rather than listing it twice', () => {
    const { tracker, feed } = feeder();
    balance(feed, 'Your balance at Bank of Godfrey is:', '310335 copper farthings');
    balance(feed, 'Your balance at The Bank of Godfrey (#8) is:', '400000 copper farthings');
    expect(tracker.current.banks).toEqual([
      { shop: 8, name: 'Bank of Godfrey', copper: 400_000, at: expect.any(Number) }
    ]);
  });

  /*
   * The vault under two spellings at once, which is what a character gets by
   * being read on one realm and then on a derivative that prints the id. The
   * id has to win over the whole list rather than over whichever row comes
   * first — otherwise the unided row is updated, the ided row is left behind,
   * and the card's total counts one vault twice.
   */
  it('folds a name-keyed row into the id that arrives for it', () => {
    const { tracker, feed } = feeder();
    balance(feed, 'Your balance at Bank of Godfrey is:', '50 copper farthings');
    balance(feed, 'Your balance at The Bank of Godfrey (#8) is:', '100 copper farthings');
    balance(feed, 'Your balance at The Bank of Godfrey (#8) is:', '999 copper farthings');
    expect(tracker.current.banks).toEqual([
      { shop: 8, name: 'Bank of Godfrey', copper: 999, at: expect.any(Number) }
    ]);
  });

  /* Two vaults that genuinely are two vaults stay two, ids or not. */
  it('keeps distinct vaults distinct', () => {
    const { tracker, feed } = feeder();
    balance(feed, 'Your balance at Bank of Godfrey (#8) is:', '50 copper farthings');
    balance(feed, 'Your balance at Bank of Albion (#185) is:', '100 copper farthings');
    expect(tracker.current.banks.map((b) => b.shop)).toEqual([8, 185]);
  });

  it('has no banks before one has answered', () => {
    const { tracker } = feeder();
    expect(tracker.current.banks).toEqual([]);
  });

  /*
   * A balance outlives the socket, because `bank` answers only for the counter
   * the character is standing at: a figure read in Godfrey is unreadable again
   * until somebody walks back there. The seeding happens at `reset()` and not
   * at `useVaults`, which is exactly where the realm's player registry is
   * seeded and for the same reason — a reconnect is a new session, and has to
   * be filled in like the first one.
   */
  it('restores what the banks said before this session, with the time they said it', () => {
    const kept = [{ shop: 8, name: 'Bank of Godfrey', copper: 310_335, at: 1_600_000_000_000 }];
    const { tracker } = feeder();

    tracker.useBelongings({
      ...NO_BELONGINGS,
      recallBanks: () => kept
    });
    tracker.reset();

    expect(tracker.current.banks).toEqual(kept);
  });

  /* Copied on the way in: a session must not be able to edit the record. */
  it('does not hand the store a reference into live state', () => {
    const kept = [{ shop: 8, name: 'Bank of Godfrey', copper: 310_335, at: 1_600_000_000_000 }];
    const { tracker, feed } = feeder();

    tracker.useBelongings({
      ...NO_BELONGINGS,
      recallBanks: () => kept
    });
    tracker.reset();
    balance(feed, 'Your balance at Bank of Godfrey is:', '999 copper farthings');

    expect(kept[0]?.copper).toBe(310_335);
  });

  it('writes a balance down the moment a vault states one', () => {
    const written: number[] = [];
    const { tracker, feed } = feeder();

    tracker.useBelongings({
      ...NO_BELONGINGS,
      rememberBanks: (banks) => written.push(banks.length)
    });
    balance(feed, 'Your balance at Bank of Godfrey is:', '310335 copper farthings');
    balance(feed, 'Your balance at Rhudaur Bank is:', '42 copper farthings');

    // The whole merged list each time, not the entry that moved: the merge is
    // `withBankBalance`'s and re-deriving it in the store would be a second
    // copy of the rule that decides when two printed names are one vault.
    expect(written).toEqual([1, 2]);
  });

  it('takes a deposit out of the purse', () => {
    const { tracker, feed } = feeder();
    purse(feed, 102_351);
    feed('You deposit 102351 copper farthings.');
    expect(tracker.current.inventory.wealth).toBe(0);
  });

  /*
   * The deposit's own sentence names no bank — but the `bank` that answered in
   * this room did, and the character has not moved since. That is the
   * maintained-listing shape: a command establishes the figure and the
   * sentences the server volunteers keep it true.
   */
  it('credits the vault named by the bank in this room', () => {
    const { tracker, feed } = feeder();
    balance(feed, 'Your balance at Bank of Godfrey is:', '310335 copper farthings');
    purse(feed, 102_351);
    feed('You deposit 102351 copper farthings.');
    expect(tracker.current.banks[0]?.copper).toBe(412_686);
    expect(tracker.current.inventory.wealth).toBe(0);
  });

  /*
   * And nothing at all when no bank has spoken here. The room is not a
   * substitute: it resolves to a bank shop only with a realm file loaded, the
   * room matched and a shop recorded for it, and crediting on that chain
   * attributes money to the wrong vault rather than to none.
   */
  it('credits nothing when no bank has answered in this room', () => {
    const { tracker, feed } = feeder();
    purse(feed, 102_351);
    feed('You deposit 102351 copper farthings.');
    expect(tracker.current.banks).toEqual([]);
    expect(tracker.current.inventory.wealth).toBe(0);
  });

  /*
   * The vault belongs to the room it answered in, exactly as a shop's listing
   * does. Walk to the next town and deposit without asking, and there is
   * nothing to credit — which is absence, not the wrong bank.
   */
  it('forgets the vault once the character has walked away', () => {
    const { tracker, feed } = feeder();
    balance(feed, 'Your balance at Bank of Godfrey is:', '310335 copper farthings');
    purse(feed, 102_351);
    feed('Silverwood Glade');
    feed('Obvious exits: north');
    feed('You deposit 102351 copper farthings.');
    expect(tracker.current.banks[0]?.copper).toBe(310_335);
    expect(tracker.current.inventory.wealth).toBe(0);
  });

  /*
   * The other half of the round trip, and the reason the classifier splits a
   * prompt's tail at all: this sentence arrives on the prompt's own framed
   * line, so for three phases no rule could see it (`logs/2026-08-30_23-00-16`).
   */
  it('reads a withdrawal the server glued to the prompt', () => {
    const { tracker, feed } = feeder();
    balance(feed, 'Your balance at Bank of Godfrey is:', '310335 copper farthings');
    purse(feed, 0);
    feed('[HP=334/KAI=27]:You withdrew 20000 copper farthings.');
    expect(tracker.current.inventory.wealth).toBe(20_000);
    expect(tracker.current.banks[0]?.copper).toBe(290_335);
  });

  /*
   * A vault cannot go below nothing. A balance that has drifted is a reading
   * to correct with one `bank`; a negative one is a bug wearing a number.
   */
  it('never draws a vault below zero', () => {
    const { tracker, feed } = feeder();
    balance(feed, 'Your balance at Bank of Godfrey is:', '100 copper farthings');
    feed('You withdrew 20000 copper farthings.');
    expect(tracker.current.banks[0]?.copper).toBe(0);
  });

  /*
   * Null is not zero. Depositing against a purse nobody has counted must not
   * invent the figure this transaction happened to name.
   */
  it('leaves an uncounted purse uncounted', () => {
    const { tracker, feed } = feeder();
    feed('You deposit 102351 copper farthings.');
    expect(tracker.current.inventory.wealth).toBeNull();
  });
});

/*
 * Putting something on and taking it off, which moves an item without moving
 * it anywhere: it was carried before and it is carried after.
 *
 * Captured whole, wrap included, and replayed line for line below:
 *
 *     [HP=34]:i
 *     You are carrying padded helm (Head), padded gloves (Hands), padded pants
 *     (Legs), padded boots (Feet), quarterstaff
 *     [HP=34]:ar qua
 *     You are now holding quarterstaff.
 *     [HP=34]:rem boo
 *     You have removed padded boots.
 *     [HP=34]:ar boo
 *     You are now wearing padded boots.
 *
 * The listing is the only line in that capture that names a slot. Everything
 * after it is a sentence about an item with no slot in it, which is why the
 * slot has to be remembered rather than read.
 */
describe('wearing and removing', () => {
  const feeder = () => {
    const classifier = new Classifier();
    const tracker = new CharacterTracker();
    let seq = 0;
    const feed = (text: string): void => {
      seq += 1;
      const { block, batch } = classifier.classify({
        seq,
        at: 1_700_000_000_000 + seq,
        text,
        plain: text,
        terminator: 'newline'
      });
      tracker.apply(block);
      if (batch) tracker.apply(batch, batch.rows);
    };
    /** The capture's own listing, wrapped where the server wrapped it. */
    const listed = (): void => {
      feed('[HP=34]:');
      feed('You are carrying padded helm (Head), padded gloves (Hands), padded pants');
      feed('(Legs), padded boots (Feet), quarterstaff');
      feed('You have no keys.');
      feed('Wealth: 0 copper farthings');
      feed('Encumbrance: 260/3360 - None [7%]');
      feed('[HP=34]:');
    };
    return { tracker, feed, listed };
  };

  const item = (tracker: CharacterTracker, name: string) =>
    tracker.current.inventory.items.find((held) => held.name === name);

  it('splits the listing into a name and a slot', () => {
    const { tracker, listed } = feeder();
    listed();
    expect(tracker.current.inventory.items).toEqual([
      { name: 'padded helm', source: 'wire', slot: 'Head', equipped: true, charges: null },
      { name: 'padded gloves', source: 'wire', slot: 'Hands', equipped: true, charges: null },
      { name: 'padded pants', source: 'wire', slot: 'Legs', equipped: true, charges: null },
      { name: 'padded boots', source: 'wire', slot: 'Feet', equipped: true, charges: null },
      { name: 'quarterstaff', source: 'wire', slot: null, equipped: false, charges: null }
    ]);
  });

  /* Taking something off is not dropping it: it stays in the pack. */
  it('keeps a removed item, and only takes its slot away', () => {
    const { tracker, feed, listed } = feeder();
    listed();
    feed('You have removed padded boots.');
    expect(item(tracker, 'padded boots')).toEqual({
      name: 'padded boots',
      source: 'wire',
      slot: null,
      equipped: false,
      charges: null
    });
    expect(tracker.current.room.items).toEqual([]);
  });

  /*
   * The point of the whole exercise. `You are now wearing padded boots.` says
   * nothing about where the boots went; the listing said `(Feet)` before they
   * came off, so that is where they go back.
   */
  it('puts the slot back from what the listing said, with no second `i`', () => {
    const { tracker, feed, listed } = feeder();
    listed();
    feed('You have removed padded boots.');
    feed('You are now wearing padded boots.');
    expect(item(tracker, 'padded boots')).toEqual({
      name: 'padded boots',
      source: 'wire',
      slot: 'Feet',
      equipped: true,
      charges: null
    });
  });

  /*
   * And the honest half: a slot no listing has ever named is not invented. The
   * quarterstaff was bought after the last `i`, so the client knows it is in
   * use and does not know where.
   */
  it('says in use without naming a slot it has never been told', () => {
    const { tracker, feed, listed } = feeder();
    listed();
    feed('You are now holding quarterstaff.');
    expect(item(tracker, 'quarterstaff')).toEqual({
      name: 'quarterstaff',
      source: 'wire',
      slot: null,
      equipped: true,
      charges: null
    });
  });

  /* Wielding and wearing are one block type, so both reach the same consumer. */
  it('reads holding as equipping', () => {
    const { tracker, feed, listed } = feeder();
    listed();
    feed('You are now holding quarterstaff.');
    feed('You have removed quarterstaff.');
    expect(item(tracker, 'quarterstaff')?.equipped).toBe(false);
    feed('You are now holding quarterstaff.');
    expect(item(tracker, 'quarterstaff')?.equipped).toBe(true);
  });

  /*
   * Something worn before any listing has been asked for. Refusing to add it
   * would leave the card silent about an item the server has just confirmed the
   * character is holding — and the next `i` replaces the lot anyway.
   */
  it('adds something equipped that no listing has mentioned', () => {
    const { tracker, feed } = feeder();
    feed('[HP=34]:');
    feed('You are now wearing padded boots.');
    expect(tracker.current.inventory.items).toEqual([
      { name: 'padded boots', source: 'wire', slot: null, equipped: true, charges: null }
    ]);
  });

  /* A lit lantern is equipped by the same sentence family. */
  it('reads lighting something as equipping it', () => {
    const { tracker, feed } = feeder();
    feed('[HP=34]:');
    feed('You lit the lantern.');
    expect(item(tracker, 'lantern')?.equipped).toBe(true);
  });

  /* The remembered slot outlives the listing that taught it. */
  it('survives a listing that no longer mentions the item', () => {
    const { tracker, feed, listed } = feeder();
    listed();
    feed('You have removed padded boots.');
    feed('You dropped padded boots.');
    feed('You took padded boots.');
    feed('You are now wearing padded boots.');
    expect(item(tracker, 'padded boots')?.slot).toBe('Feet');
  });

  /* And the whole capture, in order, ending where it ended. */
  it('replays the capture', () => {
    const { tracker, feed, listed } = feeder();
    feed('You just bought quarterstaff for 0 copper farthings.');
    listed();
    feed('You are now holding quarterstaff.');
    feed('You have removed padded boots.');
    feed('You have removed quarterstaff.');
    feed('You are now holding quarterstaff.');
    feed('You are now wearing padded boots.');
    feed('You have removed padded boots.');
    feed('You are now wearing padded boots.');
    expect(tracker.current.inventory.items).toEqual([
      { name: 'padded helm', source: 'wire', slot: 'Head', equipped: true, charges: null },
      { name: 'padded gloves', source: 'wire', slot: 'Hands', equipped: true, charges: null },
      { name: 'padded pants', source: 'wire', slot: 'Legs', equipped: true, charges: null },
      { name: 'padded boots', source: 'wire', slot: 'Feet', equipped: true, charges: null },
      { name: 'quarterstaff', source: 'wire', slot: null, equipped: true, charges: null }
    ]);
  });
});

/*
 * A fight, written down.
 *
 * Nothing reads these yet, which is the point: every question worth asking
 * about how a character fights needs a record that predates the question. What
 * is asserted here is that the record carries the *conditions* as well as the
 * measurement — a damage figure without a level, a class and what was worn
 * cannot be compared with anything, and that is the whole reason it is a record
 * rather than a counter.
 */
describe('what a fight is written down as', () => {
  function fought(...lines: string[]): FightRecord[] {
    const written: FightRecord[] = [];
    play(
      [
        '[HP=30/MA=12]:',
        'Name: Vaelor    Lives/CP: 3/12',
        'Race: Kang        Exp: 261             Perception:     57',
        'Class: Mystic     Level: 1             Stealth:        46',
        'Hits:    30/34    Armour Class:  10/1  Thievery:        0',
        // A batch ends on a status line or not at all, so each of these needs
        // one behind it — the same courtesy the smoke fixture's own note asks
        // for, and for the same reason.
        '[HP=30/MA=12]:',
        'You are carrying quarterstaff (Weapon Hand), a rope.',
        '[HP=30/MA=12]:',
        '*Combat Engaged*',
        ...lines,
        '*Combat Off*'
      ],
      undefined,
      undefined,
      { record: (fight) => written.push(fight) }
    );
    return written;
  }

  it('records what it cost and what killed it', () => {
    const [fight] = fought(
      'You punch giant rat for 8 damage!',
      'The giant rat bites you for 2 damage!',
      'You punch giant rat for 6 damage!',
      'You gain 9 experience.'
    );
    expect(fight).toMatchObject({ mob: 'giant rat', mine: 14, others: 0, killed: true });
  });

  /* The conditions, which is what makes two records comparable at all. */
  it('records the character it was fought by', () => {
    const [fight] = fought('You punch giant rat for 8 damage!');
    expect(fight).toMatchObject({
      name: 'Vaelor',
      race: 'Kang',
      className: 'Mystic',
      level: 1,
      hpMax: 34
    });
  });

  /*
   * Worn and wielded only. What is merely in the pack changes nothing about a
   * fight except how much it weighs, and that is `encumbrance`.
   */
  it('records what was in use, and not what was merely carried', () => {
    const [fight] = fought('You punch giant rat for 8 damage!');
    expect(fight?.gear).toEqual([{ name: 'quarterstaff', slot: 'Weapon Hand' }]);
  });

  /*
   * The lore refuses to *learn* from a kill this client did not open, because a
   * minimum estimator that accepts an undercount keeps it for good. The record
   * has no such problem: it carries the flag, so whoever reads it later decides
   * — and a fight thrown away here is one nobody can ever ask about.
   */
  it('records a fight it joined halfway, and says it joined halfway', () => {
    const [fight] = fought(
      'Grimjaw slashes the giant rat for 20 damage!',
      'You punch giant rat for 3 damage!',
      'You gain 9 experience.'
    );
    expect(fight).toMatchObject({ opened: false, mine: 3, others: 20, killed: true });
  });

  it('writes nothing for a fight in which nothing was hit', () => {
    expect(fought('The giant rat swings at you.')).toEqual([]);
  });
});

/*
 * What the capture corpus taught the tracker (docs/capture-analysis.md). Every
 * line is verbatim from `captures/`.
 */
describe('what the prompt says on other realms', () => {
  it('takes the maxima from a prompt that carries them', () => {
    const t = play(['[HP=498/498,MA=391/442]:']);
    expect(t.current.vitals).toMatchObject({
      hp: 498,
      hpMax: 498,
      mana: 391,
      manaMax: 442,
      manaType: 'MA'
    });
  });

  it('reads the single-letter keys as the same two resources', () => {
    const t = play(['[H=100|M=50|E=200]:']);
    expect(t.current.vitals).toMatchObject({ hp: 100, mana: 50, manaType: 'MA' });
  });

  it('reads the fields the player switched on, and skips the rest', () => {
    const t = play([
      '[HP=600/600,MA=100/100,Exp=12345,Need=999]:',
      '[HP=200/200,Wealth=5000,Need=12]:'
    ]);
    expect(t.current.progress).toMatchObject({ exp: 12345, expNeeded: 12 });
    expect(t.current.inventory.wealth).toBe(5000);
  });

  it('keeps a maximum the stat sheet gave when the prompt does not carry one', () => {
    const t = play(['[HP=498/498]:', '[HP=400]:']);
    expect(t.current.vitals).toMatchObject({ hp: 400, hpMax: 498 });
  });

  it('knows which realm the wire said it is', () => {
    expect(play(['[PARADIGM]:']).current.realm).toBe('paradigm');
    expect(play(['[MAJORMUD]:']).current.realm).toBe('majormud');
    expect(play(['Welcome to the official GreaterMUD server!']).current.realm).toBe('greatermud');
    // The menu names the data; the welcome names the server, and yields to it.
    expect(play(['Welcome to the official GreaterMUD server!', '[PARADIGM]:']).current.realm).toBe(
      'paradigm'
    );
    expect(play([]).current.realm).toBeNull();
  });

  it('rests on the sentence before the flag arrives', () => {
    expect(play(['[HP=50]:', 'You are now resting.']).current.vitals.resting).toBe(true);
  });
});

describe('the opening of a PvP fight', () => {
  it('puts the attacker in the room and in attackers a round before any damage', () => {
    const t = play(['[HP=159]:', 'Rend moves to attack you!']);
    expect(t.current.combat.attackers).toEqual(['Rend']);
    expect(names(t.current.room.occupants)).toContain('Rend');
  });

  it('names a guessed attacker only when the roster or the room can vouch for it', () => {
    // `Acid burns you` has the shape of a player's blow, and names nobody.
    const acid = play(['[HP=38/MA=10]:', 'Acid burns you for 1 damage!']);
    expect(acid.current.combat.attackers).toEqual([]);
    expect(acid.current.combat.blows).toBe(1);
    // A hidden player who just opened on you is on the realm roster.
    const rend = play([
      '[HP=159]:',
      '             Current Adventurers',
      '             ===================',
      '             Rend                  -  Apprentice S',
      '[HP=159]:',
      'Rend surprise chops you for 59 damage!'
    ]);
    expect(rend.current.combat.attackers).toEqual(['Rend']);
  });

  it('changes nothing for somebody else’s fight', () => {
    const t = play(['[HP=159]:', 'Cercio moves to attack massive ice dragon.']);
    expect(t.current.combat.attackers).toEqual([]);
  });

  it('does not set this character’s target to a spell', () => {
    const t = play([
      '[HP=98/MA=50]:',
      '*Combat Engaged*',
      'You fire an acid jet at Thrag for 34 damage!'
    ]);
    expect(t.current.combat.target).toBeNull();
    expect(t.current.combat.blows).toBe(1);
  });

  it('takes a dead player out of the room and the fight', () => {
    const t = play([
      '[HP=159]:',
      'Rend moves to attack you!',
      'Rend drops to the ground!',
      'Rend is dead.'
    ]);
    expect(t.current.combat.attackers).toEqual([]);
    expect(names(t.current.room.occupants)).not.toContain('Rend');
  });

  it('puts both sides of somebody else’s swing in the room', () => {
    const t = play(['[HP=159]:', 'The giant wasp lunges at Caligula!']);
    expect(names(t.current.room.occupants)).toEqual(
      expect.arrayContaining(['giant wasp', 'Caligula'])
    );
  });
});

describe('loot and listings from other realms', () => {
  it('puts dropped coins on the floor until the next look replaces them', () => {
    const t = play([
      '[HP=159]:',
      'Blah Blah',
      'Obvious exits: north',
      '18 gold drop to the ground.',
      '3 silver drop to the ground.'
    ]);
    /*
     * Coins are `room.cash` now, not rows in the item list: `18 gold` among
     * the items landed in the encumbrance count and read as something to
     * `get` by name. Two drops fold into one pile, and the total is the
     * measured ladder's.
     */
    expect(t.current.room.items).toEqual([]);
    expect(t.current.room.cash).toMatchObject({ gold: 18, silver: 3, totalCopper: 1830 });
  });

  it('reads the MajorMUD party listing with its middle rank and percentages', () => {
    const t = play([
      '[HP=100]:',
      'The following people are in your travel party:',
      '  Slayer OfSouls                 (Gypsy)      [M: 81%] [H: 76%]   - Midrank',
      '  Dungeon Breath                 (Paladin)    [M: 68%] [H: 84%]   - Frontrank',
      '[HP=100]:'
    ]);
    expect(t.current.party.members).toEqual([
      {
        name: 'Slayer',
        className: 'Gypsy',
        health: 0.76,
        mana: 0.81,
        rank: 'mid',
        activity: null,
        invited: false,
        vitals: null
      },
      {
        name: 'Dungeon',
        className: 'Paladin',
        health: 0.84,
        mana: 0.68,
        rank: 'front',
        activity: null,
        invited: false,
        vitals: null
      }
    ]);
  });
});

describe('the pack listing, as captured buying from a shop', () => {
  it('reads a counted entry as that many instances, and a charge as its own field', () => {
    const t = play([
      '[HP=38/MA=10]:',
      'You are carrying torch (Readied/79), 2 scroll of magic missile',
      'You have no keys.',
      'Wealth: 0 copper farthings',
      'Encumbrance: 10/2400 - None [0%]',
      '[HP=38/MA=10]:'
    ]);
    expect(t.current.inventory.items).toEqual([
      { name: 'torch', source: 'wire', slot: 'Readied', equipped: true, charges: 79 },
      {
        name: 'scroll of magic missile',
        source: 'wire',
        slot: null,
        equipped: false,
        charges: null
      },
      {
        name: 'scroll of magic missile',
        source: 'wire',
        slot: null,
        equipped: false,
        charges: null
      }
    ]);
  });

  /*
   * `glowing pearl (Readied/0)` — Vaelor's real listing, 2026-08-27. The
   * server treats it as absent (`use glowing pearl` → `You don't have glowing
   * pearl.`), so zero is a fact worth keeping and is emphatically not the same
   * as "the listing did not count".
   */
  it('keeps a spent charge as zero rather than as nothing said', () => {
    const t = play([
      '[HP=38/MA=10]:',
      'You are carrying glowing pearl (Readied/0), quarterstaff',
      'You have no keys.',
      'Wealth: 0 copper farthings',
      'Encumbrance: 10/2400 - None [0%]',
      '[HP=38/MA=10]:'
    ]);
    expect(t.current.inventory.items).toEqual([
      { name: 'glowing pearl', source: 'wire', slot: 'Readied', equipped: true, charges: 0 },
      { name: 'quarterstaff', source: 'wire', slot: null, equipped: false, charges: null }
    ]);
  });
});

describe('being walked after a party leader', () => {
  it('treats the server’s follow as a move, so the next room is reached by one', () => {
    const t = play([
      '[HP=38/MA=10]:',
      'Newhaven, Village Entrance',
      'Obvious exits: north, south',
      'Soul just left to the north.',
      ' -- Following your Party leader north --',
      'Newhaven, Weapons Shop',
      'Also here: Soul, Nathaniel.',
      'Obvious exits: south'
    ]);
    expect(t.current.room.name).toBe('Newhaven, Weapons Shop');
    expect(names(t.current.room.occupants)).toEqual(['Soul', 'Nathaniel']);
  });
});

describe('sys go', () => {
  const HALL = { m: 1, r: 2147, n: "Newhaven, Adventurer's Guild", x: {} };
  const TWIN = { m: 2, r: 5, n: "Newhaven, Adventurer's Guild", x: {} };
  function twinWorld(): WorldGraph {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-sysgo-'));
    const file = path.join(dir, 'rooms.jsonl.gz');
    const header = JSON.stringify({ v: 1, source: 'test', rooms: 2, generatedAt: 'x' });
    fs.writeFileSync(
      file,
      zlib.gzipSync([header, JSON.stringify(HALL), JSON.stringify(TWIN)].join('\n') + '\n')
    );
    const graph = WorldGraph.load(file);
    fs.rmSync(dir, { recursive: true, force: true });
    return graph;
  }

  it('resolves the room that answers a teleport by the coordinates the command named', () => {
    // Two rooms share the name, so a name alone is ambiguous; the command is not.
    const t = play(
      ['[HP=34]:', { send: 'sys go 2 5' }, "Newhaven, Adventurer's Guild", 'Obvious exits: north'],
      twinWorld()
    );
    expect(t.current.room.resolvedBy).toBe('coordinates');
    expect(t.current.room.map).toBe(2);
    expect(t.current.room.number).toBe(5);
  });

  it('does not trust the command when the realm data disagrees about the name', () => {
    const t = play(
      ['[HP=34]:', { send: 'sys go 2 5' }, 'Somewhere Else', 'Obvious exits: north'],
      twinWorld()
    );
    expect(t.current.room.resolvedBy).not.toBe('coordinates');
  });
});

describe('leaving the realm on purpose', () => {
  const inside = [
    'Welcome back, Vaelor!',
    '[HP=34]:',
    'Bank of Godfrey',
    'Also here: Soul.',
    'Obvious exits: north'
  ];

  it('stays in the realm on the request alone: the exit takes seconds and can be broken', () => {
    const t = play([...inside, 'You will exit after a period of silent meditation.', '[HP=34]:']);
    expect(t.current.phase).toBe('in-game');
    expect(t.current.room.name).toBe('Bank of Godfrey');
  });

  /*
   * The name goes too, which is where this differs from a closed socket.
   *
   * `leaveRealm` keeps who the character is on purpose — the tab and the
   * offline card have to show somebody, and the last stat sheet is still the
   * last true thing known. The **menu** carries no such guarantee: it is
   * exactly where a player rerolls or picks somebody else, and a character
   * renamed at that menu came back with every card still naming the one
   * before it.
   */
  it('leaves when the menu arrives after a request, forgetting who was there', () => {
    const t = play([
      ...inside,
      'You will exit after a period of silent meditation.',
      '[PARADIGM]:'
    ]);
    expect(t.current.phase).toBe('authenticating');
    expect(t.current.room.name).toBeNull();
    expect(t.current.name).toBeNull();
    expect(t.current.vitals.hp).toBeNull();
    // The realm is the one thing the menu prompt itself states.
    expect(t.current.realm).toBe('paradigm');
  });

  /*
   * What survives is the *record*, which is not about standing in the realm:
   * who else plays here is learned once and asked about precisely when they
   * are no longer in front of you. Everyone is marked offline — the listing
   * described a realm this character has left — and nobody is forgotten.
   */
  it('keeps what was learned about other people across the menu', () => {
    const t = play([
      '         Current Adventurers',
      '         ===================',
      '    Good Soul                  -  Kai Warrior of Mudengine S',
      '[HP=34]:',
      ...inside,
      'You will exit after a period of silent meditation.',
      '[PARADIGM]:'
    ]);
    expect(t.current.online).toEqual([]);
    expect(t.current.players['soul']).toBeDefined();
    expect(t.current.players['soul']?.online).toBe(false);
  });

  /*
   * `quit` is not the only way back to the menu, and the account layer's own
   * questions say where the character is without needing to be corroborated —
   * a room never prints one.
   */
  it('leaves on the character menu with nothing having asked to', () => {
    const t = play([...inside, 'Please select a character:']);
    expect(t.current.phase).toBe('authenticating');
    expect(t.current.name).toBeNull();
  });

  it('treats a menu echoed inside the game as an echo when nothing asked to leave', () => {
    const t = play([...inside, '[PARADIGM]:']);
    expect(t.current.phase).toBe('in-game');
  });

  it('forgets the request once the player breaks it', () => {
    const t = play([
      ...inside,
      'You will exit after a period of silent meditation.',
      { send: 'break' },
      '[PARADIGM]:'
    ]);
    expect(t.current.phase).toBe('in-game');
  });
});

describe('coins off the floor', () => {
  /*
   * Counts one denomination up and converts nothing.
   *
   * This used to add `count × COIN_IN_COPPER` to `wealth`, and that table was
   * wrong — measured against the corpus and against this realm the ladder is
   * 1 / 10 / 100 / 10 000 / 1 000 000, so every platinum piece understated the
   * purse tenfold and every runic coin a hundredfold. With the counts kept
   * there is nothing to convert: `Wealth:` is the server's own arithmetic.
   */
  it('counts the coin picked up and takes it off the floor', () => {
    const t = play([
      '[HP=34]:',
      'You are carrying Nothing!',
      'You have no keys.',
      'Wealth: 5 copper farthings',
      'Encumbrance: 0/2400 - None [0%]',
      '[HP=34]:',
      'Blah',
      'Obvious exits: north',
      '3 silver drop to the ground.',
      'You picked up 3 silver nobles'
    ]);
    // The listing enumerated and named no silver, so it was zero; three were
    // picked up. Wealth is the figure the listing stated and is not recomputed.
    expect(t.current.inventory.coins.silver).toBe(3);
    expect(t.current.inventory.wealth).toBe(5);
    expect(t.current.room.items).toEqual([]);
    expect(t.current.inventory.items).toEqual([]);
  });

  it('leaves a denomination nothing has counted uncounted', () => {
    // No listing has been seen, so nobody has said how many silver there are.
    // Adding to that would claim the three picked up were the whole purse.
    const t = play(['[HP=34]:', 'Blah', 'Obvious exits: north', 'You picked up 3 silver nobles']);
    expect(t.current.inventory.coins.silver).toBeNull();
  });
});

describe('training at the guild', () => {
  it('takes the level from the guild’s welcome, and forgets the old maxima', () => {
    const t = play(['[HP=34]:', 'Health:   34/34 [100%]', 'Welcome to level 2!']);
    expect(t.current.progress.level).toBe(2);
    // The stat sheet that said 34 was read at level 1; 165% health followed.
    expect(t.current.vitals.hpMax).toBeNull();
  });
});

describe('coins in the pack listing', () => {
  /*
   * Counted, and not items.
   *
   * They were matched by this exact regex and then *dropped*, on the reasoning
   * that `Wealth:` already said it — one number where the listing gives five.
   * `51 gold crowns, 7 copper farthings` beside `Wealth: 5107` is also what
   * settles what `Wealth:` is: the server's own total, 51 × 100 + 7.
   */
  it('are counted per denomination, and are not items', () => {
    const t = play([
      '[HP=56/KAI=3]:',
      'You are carrying 51 gold crowns, 7 copper farthings, padded helm (Head), torch',
      'You have no keys.',
      'Wealth: 5107 copper farthings',
      'Encumbrance: 359/3360 - None [10%]',
      '[HP=56/KAI=3]:'
    ]);
    expect(t.current.inventory.items.map((item) => item.name)).toEqual(['padded helm', 'torch']);
    expect(t.current.inventory.wealth).toBe(5107);
    expect(t.current.inventory.coins).toEqual({
      runic: 0,
      platinum: 0,
      gold: 51,
      silver: 0,
      // The listing enumerates, so a denomination it does not name is none —
      // which is what lets a pick-up count up from a number afterwards.
      copper: 7
    });
  });

  it('reads all five, richest first, as the server prints them', () => {
    // `65 runic coins, 51 platinum pieces, 118 gold crowns` with
    // `Wealth: 65521800` is the corpus sample that pins the whole ladder
    // (captures/044): 65 000 000 + 510 000 + 11 800, exactly.
    const t = play([
      '[HP=649/MA=290]:',
      'You are carrying 65 runic coins, 51 platinum pieces, 118 gold crowns, light ball',
      'You have no keys.',
      'Wealth: 65521800 copper farthings',
      'Encumbrance: 1587/4320 - Medium [36%]',
      '[HP=649/MA=290]:'
    ]);
    expect(t.current.inventory.coins).toEqual({
      runic: 65,
      platinum: 51,
      gold: 118,
      silver: 0,
      copper: 0
    });
    expect(t.current.inventory.items.map((item) => item.name)).toEqual(['light ball']);
  });

  /*
   * `wealth` states the same five facts the `i` listing does, in one line for a
   * fifth of the output. Captured live 2026-08-28 by `npm run probe:tour`,
   * which found it as the one unread line of the run worth reading — the
   * arithmetic checks against the `Wealth: 225034` from the same session.
   */
  it('reads the purse off the one-line answer to `wealth`', () => {
    const t = play([
      '[HP=101/KAI=5]:',
      'You have 22 platinum pieces, 50 gold crowns, 3 silver nobles, 4 copper farthings.'
    ]);
    expect(t.current.inventory.coins).toEqual({
      runic: 0,
      platinum: 22,
      gold: 50,
      silver: 3,
      copper: 4
    });
    // The total is the server's own arithmetic and is not computed here.
    expect(t.current.inventory.wealth).toBeNull();
  });

  /*
   * The refusal that keeps the loose frame safe: the noun after a number is
   * realm data, so the pattern cannot name the denominations — and this is
   * where a sentence of the same shape about something else is dropped rather
   * than becoming a purse.
   */
  it('refuses a sentence of the same shape that names no denomination', () => {
    const t = play([
      '[HP=101/KAI=5]:',
      'You have 22 platinum pieces, 50 gold crowns, 3 silver nobles, 4 copper farthings.',
      'You have 3 lives left.'
    ]);
    expect(t.current.inventory.coins.platinum).toBe(22);
  });

  it('starts a session knowing nothing about any of them', () => {
    const t = play(['[HP=34]:']);
    expect(t.current.inventory.coins).toEqual({
      runic: null,
      platinum: null,
      gold: null,
      silver: null,
      copper: null
    });
  });
});

describe('a dark room', () => {
  it('is an arrival somewhere unknown, and leaves the fight behind', () => {
    const t = play([
      '[HP=62/KAI=4]:',
      'Dungeon, Entrance',
      'Also here: giant rat.',
      'Obvious exits: north, south',
      '*Combat Engaged*',
      'You punch giant rat for 5 damage!',
      { send: 'n' },
      "The room is very dark - you can't see anything"
    ]);
    expect(t.current.room.name).toBeNull();
    expect(t.current.room.occupants).toEqual([]);
    expect(t.current.combat.target).toBeNull();
  });

  it('changes nothing when nobody moved — a look in the dark is still here', () => {
    const t = play([
      '[HP=62/KAI=4]:',
      'Dungeon, Entrance',
      'Obvious exits: north, south',
      { send: 'l' },
      "The room is very dark - you can't see anything"
    ]);
    expect(t.current.room.name).toBe('Dungeon, Entrance');
  });

  /*
   * The failure that made this worth fixing. `pitch black` matched no pattern,
   * so nothing consumed the move and nothing cleared the room — and the client
   * went on reporting the *previous* room with a full exit list and no
   * ambiguity, which is a confidently wrong answer rather than blindness.
   */
  it('is dark at the darkest phrase too, rather than leaving the last room standing', () => {
    const t = play([
      '[HP=62/KAI=4]:',
      'Twisting Alley',
      'Obvious exits: north, south',
      { send: 'n' },
      "The room is pitch black - you can't see anything"
    ]);
    expect(t.current.room.name).toBeNull();
    expect(t.current.room.exits).toEqual([]);
    expect(t.current.room.light).toBe('pitch black');
  });

  /*
   * The other two phrases arrive *after* `Obvious exits:` (captures/009,
   * captures/022), so they annotate a room already on the books. Reading them
   * as an arrival would consume a move that nothing made.
   */
  it('annotates the room already read when the phrase is not a blinding one', () => {
    const t = play([
      '[HP=62/KAI=4]:',
      'Slimy Tunnel',
      'Obvious exits: south',
      'The room is barely visible'
    ]);
    expect(t.current.room.name).toBe('Slimy Tunnel');
    expect(t.current.room.light).toBe('barely visible');
    expect(t.pendingMoves).toBe(0);
  });
});

/*
 * A room the server refuses to describe can still be placed, from the previous
 * room and the direction walked — and only when the realm data agrees the
 * destination is dark. Measured live 2026-08-27: `1/17` has `d → 1/607 Sewer
 * Tunnel`, light −175, and the client knew both before it stepped.
 */
describe('dead reckoning into the dark', () => {
  const LIT = {
    m: 1,
    r: 17,
    n: 'Intersection of Brass St. & River St.',
    x: { d: { m: 1, r: 607 } }
  };
  const DARK = { m: 1, r: 607, n: 'Sewer Tunnel', li: -175, x: { u: { m: 1, r: 17 } } };
  // A namesake, so name matching could not have produced the answer: this is
  // the case in the realm — 98% of dark rooms share their name with another.
  const TWIN = { m: 1, r: 608, n: 'Sewer Tunnel', li: -175, x: {} };
  const BRIGHT = { m: 1, r: 18, n: 'Brass Street', x: { w: { m: 1, r: 17 } } };
  const OUT = { m: 1, r: 19, n: 'River Street', x: {} };

  function darkWorld(rooms: object[]): WorldGraph {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-dark-'));
    const file = path.join(dir, 'rooms.jsonl.gz');
    const header = JSON.stringify({ v: 1, source: 'test', rooms: rooms.length, generatedAt: 'x' });
    fs.writeFileSync(
      file,
      zlib.gzipSync([header, ...rooms.map((room) => JSON.stringify(room))].join('\n') + '\n')
    );
    const graph = WorldGraph.load(file);
    fs.rmSync(dir, { recursive: true, force: true });
    return graph;
  }

  it('places the character when the realm agrees the destination is dark', () => {
    const t = play(
      [
        '[HP=62/KAI=4]:',
        'Intersection of Brass St. & River St.',
        'Obvious exits: down',
        { send: 'd' },
        "The room is pitch black - you can't see anything"
      ],
      darkWorld([LIT, DARK, TWIN])
    );
    expect(t.current.room.map).toBe(1);
    expect(t.current.room.number).toBe(607);
    expect(t.current.room.resolvedBy).toBe('dead-reckoning');
    // Below the 0.98 a name-verified move earns: nothing corroborated the
    // arrival except agreement about the dark.
    expect(t.current.room.confidence).toBeLessThan(0.98);
    expect(t.current.room.light).toBe('pitch black');
  });

  /*
   * The refusal, which is the half that keeps this honest. If the realm says
   * the destination is lit, the character is somewhere it did not expect and
   * placing it there would be the confident wrong answer.
   */
  it('refuses when the realm says the destination is lit, and keeps the working', () => {
    const t = play(
      [
        '[HP=62/KAI=4]:',
        'Intersection of Brass St. & River St.',
        'Obvious exits: east',
        { send: 'e' },
        "The room is pitch black - you can't see anything"
      ],
      darkWorld([{ ...LIT, x: { e: { m: 1, r: 18 } } }, BRIGHT, OUT])
    );
    expect(t.current.room.map).toBeNull();
    expect(t.current.room.number).toBeNull();
    expect(t.current.room.resolvedBy).toBeNull();
    expect(t.current.room.candidates.map((c) => c.name)).toEqual(['Brass Street']);
  });

  it('says nothing when it does not know where it started from', () => {
    const t = play(
      ['[HP=62/KAI=4]:', { send: 'd' }, "The room is pitch black - you can't see anything"],
      darkWorld([LIT, DARK, TWIN])
    );
    expect(t.current.room.map).toBeNull();
    expect(t.current.room.light).toBe('pitch black');
  });

  /*
   * A blinded character is told `You are blind.` in a torchlit hall as readily
   * as in a cavern, so there is nothing for the realm data to agree with and
   * the darkness refusal above must not apply — it would throw away the only
   * answer there is. Less corroboration, so lower confidence; that is what the
   * number is for.
   */
  it('places a blinded character into a lit room, which the dark refusal would not', () => {
    const t = play(
      [
        '[HP=62/KAI=4]:',
        'Intersection of Brass St. & River St.',
        'Obvious exits: east',
        { send: 'e' },
        'You are blind.'
      ],
      darkWorld([{ ...LIT, x: { e: { m: 1, r: 18 } } }, BRIGHT, OUT])
    );
    expect(t.current.room.number).toBe(18);
    expect(t.current.room.resolvedBy).toBe('dead-reckoning');
    expect(t.current.room.confidence).toBeLessThan(0.75);
    // Nothing was said about the light, so nothing is claimed about it.
    expect(t.current.room.light).toBeNull();
  });
});

/*
 * `You are blind.` is a room block wearing a condition's words: the server
 * prints it in place of every room it would otherwise draw, and 31 of the 31
 * in the corpus arrive directly after a status line — it is always an answer.
 *
 * Read as the onset of blindness, nothing consumed the move it answers, and
 * `pendingMoves` never came back down. Auto-combat does not hit back while a
 * step is unanswered, so the player's log of 2026-09-01 has a slime beast
 * swinging at a character that never once swung back, for two hours.
 */
describe('a room the character cannot see', () => {
  it('is the arrival, and consumes the move that earned it', () => {
    const t = play([
      '[HP=311/KAI=27]:',
      'Huge Cave, Ledge',
      'Also here: black orc shaman.',
      'Obvious exits: northwest',
      { send: 'nw' },
      'You are blind.'
    ]);
    expect(t.pendingMoves).toBe(0);
    // The room it left is not the room it is in, and saying so is the point.
    expect(t.current.room.name).toBeNull();
    expect(t.current.room.occupants).toEqual([]);
  });

  it('leaves the fight behind with the room, as a dark arrival does', () => {
    const t = play([
      '[HP=311/KAI=27]:',
      'Huge Cave, Ledge',
      'Obvious exits: northwest',
      '*Combat Engaged*',
      'You punch black orc shaman for 5 damage!',
      'The black orc shaman swipes at you with their iron-capped staff, but you dodge!',
      { send: 'nw' },
      'You are blind.'
    ]);
    expect(t.current.combat.target).toBeNull();
    expect(t.current.combat.attackers).toEqual([]);
  });

  /*
   * The player's log of 2026-09-01, replayed whole against the real realm.
   *
   * It is the whole of what the client had to go on: no room block, no arrival
   * sentence — a blinded character sees neither — and only the monster's
   * swings to say anything was in the pit at all. The name comes off the realm
   * data, the placement off the previous room and the step, and both are
   * checked against what the server itself said afterwards: the `rm` the
   * player eventually sent read `Location: 1,1765`.
   */
  it.runIf(realm !== null && realm.size > 0)(
    'leaves what is swinging in the dark on the books, hittable, and placed',
    () => {
      const t = play(
        [
          '[HP=311/KAI=27]:',
          'Location:            1,1764',
          { send: 'nw' },
          'You step onto the crumbling edge of a pit, and fall inside!',
          'You are blind.',
          'The slime beast flails at you, but you dodge out of the way!'
        ],
        realm!
      );
      expect(t.pendingMoves).toBe(0);
      expect(t.current.combat.attackers).toEqual(['slime beast']);
      expect(names(t.current.room.occupants)).toEqual(['slime beast']);
      expect(`${t.current.room.map},${t.current.room.number}`).toBe('1,1765');
    }
  );

  /*
   * A bare Enter, a `look` and a `look <mob>` are all answered with it too
   * (captures/007, captures/191), and none of them moved the character. Only
   * the head of the queue can say which this is, exactly as for a dark room.
   */
  it('changes nothing when nobody moved', () => {
    const t = play([
      '[HP=311/KAI=27]:',
      'Huge Cave, Ledge',
      'Also here: black orc shaman.',
      'Obvious exits: northwest',
      { send: 'l' },
      'You are blind.'
    ]);
    expect(t.current.room.name).toBe('Huge Cave, Ledge');
    expect(names(t.current.room.occupants)).toEqual(['black orc shaman']);
  });

  /* And a peek is consumed by it, so the next real room is not read against it. */
  it('consumes a peek without moving the character', () => {
    const t = play([
      '[HP=311/KAI=27]:',
      'Huge Cave, Ledge',
      'Obvious exits: northwest',
      { send: 'l nw' },
      'You are blind.'
    ]);
    expect(t.pendingCount).toBe(0);
    expect(t.current.room.name).toBe('Huge Cave, Ledge');
  });

  /*
   * It only reaches the wire while the condition holds, so it restates it —
   * which matters because a cure the server answers with nothing leaves the
   * flag exactly where it was.
   */
  it('says the character is still blind', () => {
    const t = play(['[HP=311/KAI=27]:', 'You are blind.']);
    expect(t.current.afflictions.blind).toBe('yes');
  });

  /* And the onset, which is the other sentence and was matching nothing. */
  it('reads the onset off the bang, beside the attack that caused it', () => {
    const t = play(['[HP=311/KAI=27]:', 'black orc shaman casts blind on you!', 'You are blind!']);
    expect(t.current.afflictions.blind).toBe('yes');
  });
});

/*
 * The walker hints a `Text:` exit before sending it, so a walked `go manhole`
 * has always resolved. A **hand-typed** one had nothing to supply the
 * direction, and the sewer it reaches is one of 293 rooms called `Sewer
 * Tunnel` — so a player exploring lost their place at the one exit the realm
 * data describes best.
 */
describe('a text exit the player types', () => {
  const STREET = {
    m: 1,
    r: 17,
    n: 'Intersection of Brass St. & River St.',
    x: { d: { m: 1, r: 607, i: 'Text: go manhole, go man, enter manhole' } }
  };
  const SEWER = { m: 1, r: 607, n: 'Sewer Tunnel', x: { u: { m: 1, r: 17 } } };

  function streetWorld(): WorldGraph {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-text-exit-'));
    const file = path.join(dir, 'rooms.jsonl.gz');
    const header = JSON.stringify({ v: 1, source: 'test', rooms: 2, generatedAt: 'x' });
    fs.writeFileSync(
      file,
      zlib.gzipSync([header, JSON.stringify(STREET), JSON.stringify(SEWER)].join('\n') + '\n')
    );
    const graph = WorldGraph.load(file);
    fs.rmSync(dir, { recursive: true, force: true });
    return graph;
  }

  it('is a move, derived from the room’s own exits', () => {
    const t = play(
      [
        '[HP=62/KAI=4]:',
        'Intersection of Brass St. & River St.',
        'Obvious exits: down',
        { send: 'go manhole' }
      ],
      streetWorld()
    );
    expect(t.pendingMoves).toBe(1);
  });

  it('takes any of the phrasings the realm names', () => {
    const t = play(
      [
        '[HP=62/KAI=4]:',
        'Intersection of Brass St. & River St.',
        'Obvious exits: down',
        { send: 'enter manhole' }
      ],
      streetWorld()
    );
    expect(t.pendingMoves).toBe(1);
  });

  it('is not a move when the realm names no such command here', () => {
    const t = play(
      [
        '[HP=62/KAI=4]:',
        'Intersection of Brass St. & River St.',
        'Obvious exits: down',
        { send: 'go hatch' }
      ],
      streetWorld()
    );
    expect(t.pendingMoves).toBe(0);
  });
});

describe('a move the walker hinted', () => {
  it('expects a room for a text-exit command instead of holding it unmodelled', () => {
    const tracker = play(['[HP=31]: ']);
    // `go manhole` is not in the command table, so alone it would sit in the
    // unmodelled slot and the sewer room would fall back to name matching —
    // against 293 rooms called Sewer Tunnel.
    tracker.hintMove('go manhole', 'd');
    tracker.observeCommand('go manhole');
    expect(tracker.pendingMoves).toBe(1);
  });

  it('is not eaten by another command holding the queue', () => {
    const tracker = play(['[HP=31]: ']);
    tracker.hintMove('go manhole', 'd');
    // The player typed something while the step waited in the queue.
    tracker.observeCommand('l');
    tracker.observeCommand('go manhole');
    expect(tracker.pendingMoves).toBe(1);
  });

  it('is superseded by a typed direction', () => {
    const tracker = play(['[HP=31]: ']);
    tracker.hintMove('go manhole', 'd');
    tracker.observeCommand('n');
    tracker.observeCommand('go manhole');
    // The `n` is the one move expected; the hint did not survive it.
    expect(tracker.pendingMoves).toBe(1);
  });
});

describe('a reprint while a move is in flight', () => {
  /*
   * Measured live (2026-08-27): the sewer fight ended, the server reprinted
   * the room unasked, the reprint consumed the `e` still in flight, and the
   * real arrival — with no expectation left — fell back to name matching
   * among 293 Sewer Tunnels. A known location died of a courtesy.
   */
  const INTERSECTION = {
    m: 1,
    r: 622,
    n: 'Sewer Tunnel, Intersection',
    x: { e: { m: 1, r: 623 } }
  };
  const TUNNEL = { m: 1, r: 623, n: 'Sewer Tunnel', x: { w: { m: 1, r: 622 } } };
  // A namesake, so re-deriving the intersection by name would be ambiguous —
  // which is what proves identity was kept rather than re-found.
  const TWIN = { m: 1, r: 700, n: 'Sewer Tunnel, Intersection', x: { e: { m: 1, r: 701 } } };

  function sewerWorld(): WorldGraph {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-reprint-'));
    const file = path.join(dir, 'rooms.jsonl.gz');
    const header = JSON.stringify({ v: 1, source: 'test', rooms: 3, generatedAt: 'x' });
    fs.writeFileSync(
      file,
      zlib.gzipSync(
        [header, JSON.stringify(INTERSECTION), JSON.stringify(TUNNEL), JSON.stringify(TWIN)].join(
          '\n'
        ) + '\n'
      )
    );
    const graph = WorldGraph.load(file);
    fs.rmSync(dir, { recursive: true, force: true });
    return graph;
  }

  const INTERSECTION_LINES = ['Sewer Tunnel, Intersection', 'Obvious exits: east'];
  const TUNNEL_LINES = ['Sewer Tunnel', 'Obvious exits: west'];

  function sewerSession(): { tracker: CharacterTracker; feed: (lines: string[]) => void } {
    const classifier = new Classifier();
    const tracker = new CharacterTracker(sewerWorld());
    let seq = 0;
    const feed = (lines: string[]): void => {
      for (const plain of lines) {
        seq += 1;
        const line: StreamLine = {
          seq,
          at: 1_700_000_000_000 + seq,
          text: plain,
          plain,
          terminator: 'newline'
        };
        const { block, batch } = classifier.classify(line);
        tracker.apply(block);
        if (batch) tracker.apply(batch);
      }
    };
    return { tracker, feed };
  }

  it('leaves the move for the room still coming, and keeps the location', () => {
    const { tracker, feed } = sewerSession();
    feed(['Location:            1,622', ...INTERSECTION_LINES]);
    expect(tracker.current.room.number).toBe(622);

    tracker.observeCommand('e');
    // The courtesy reprint arrives before the move lands.
    feed(INTERSECTION_LINES);
    expect(tracker.current.room.number).toBe(622);
    expect(tracker.pendingMoves).toBe(1);

    // The real arrival consumes the move and dead-reckons through it.
    feed(TUNNEL_LINES);
    expect(tracker.current.room.number).toBe(623);
    expect(tracker.pendingMoves).toBe(0);
  });
});

describe('a reprint the client asked for', () => {
  /*
   * The case the guard above cannot settle, and the one that shipped.
   *
   * `Walker` nudges a step that has not been answered inside a second with a
   * bare Enter. The server then answers the step and the nudge in one packet —
   * two identical room blocks — and the client read the second as the arrival
   * of the step it had just sent on the strength of the first. Measured
   * 2026-09-02 (`2026-09-02_18-07-07_festus.mudcap.jsonl`, t=4862445): `e`
   * went out twice inside three milliseconds and the walk ran a room ahead of
   * the character for the rest of the lap.
   *
   * Nothing in the block says it is wrong. The reprint prints `east, west`,
   * which is a *subset* of the destination's exits, and the destination is a
   * namesake — so the name half of the guard ties and the exit half cannot
   * refuse it. What settles it is that the client asked for that room block.
   */
  const HERE = {
    m: 1,
    r: 900,
    n: 'Sewer Tunnel',
    x: { e: { m: 1, r: 901 }, w: { m: 1, r: 899 } }
  };
  // The step's destination: a namesake whose exits are a superset of what the
  // reprint prints, which is what makes the two blocks indistinguishable.
  const EAST = {
    m: 1,
    r: 901,
    n: 'Sewer Tunnel',
    x: { n: { m: 1, r: 910 }, e: { m: 1, r: 902 }, w: { m: 1, r: 900 } }
  };

  function tunnels(): WorldGraph {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-asked-'));
    const file = path.join(dir, 'rooms.jsonl.gz');
    const header = JSON.stringify({ v: 1, source: 'test', rooms: 2, generatedAt: 'x' });
    fs.writeFileSync(
      file,
      zlib.gzipSync([header, JSON.stringify(HERE), JSON.stringify(EAST)].join('\n') + '\n')
    );
    const graph = WorldGraph.load(file);
    fs.rmSync(dir, { recursive: true, force: true });
    return graph;
  }

  const HERE_LINES = ['Sewer Tunnel', 'Obvious exits: east, west'];
  const EAST_LINES = ['Sewer Tunnel', 'Obvious exits: closed door north, east, west'];

  function session(): { tracker: CharacterTracker; feed: (lines: string[]) => void } {
    const classifier = new Classifier();
    const tracker = new CharacterTracker(tunnels());
    let seq = 0;
    const feed = (lines: string[]): void => {
      for (const plain of lines) {
        seq += 1;
        const line: StreamLine = {
          seq,
          at: 1_700_000_000_000 + seq,
          text: plain,
          plain,
          terminator: 'newline'
        };
        const { block, batch } = classifier.classify(line);
        tracker.apply(block);
        if (batch) tracker.apply(batch);
      }
    };
    return { tracker, feed };
  }

  it('does not let the nudge’s reprint answer the step sent behind it', () => {
    const { tracker, feed } = session();
    feed(['[HP=80/KAI=5]:', 'Location:            1,900', ...HERE_LINES]);
    expect(tracker.current.room.number).toBe(900);

    // The step is unanswered for a second, so the walker nudges.
    tracker.observeReread();
    expect(tracker.pendingMoves).toBe(0);

    // The walker confirms the room it is standing in and sends the next step.
    tracker.observeCommand('e');
    expect(tracker.pendingMoves).toBe(1);

    // And the nudge's reprint lands. It is the room already resolved, and the
    // step's own answer is still coming.
    feed(HERE_LINES);
    expect(tracker.current.room.number).toBe(900);
    expect(tracker.pendingMoves).toBe(1);

    // Which arrives, and is what moves the character.
    feed(EAST_LINES);
    expect(tracker.current.room.number).toBe(901);
    expect(tracker.pendingMoves).toBe(0);
  });

  it('answers a bare look the same way, and a peek not at all', () => {
    const { tracker, feed } = session();
    feed(['[HP=80/KAI=5]:', 'Location:            1,900', ...HERE_LINES]);

    tracker.observeCommand('l');
    tracker.observeCommand('e');
    feed(HERE_LINES);
    // The look answered itself; the step is still out.
    expect(tracker.pendingMoves).toBe(1);
    expect(tracker.current.room.number).toBe(900);

    feed(EAST_LINES);
    expect(tracker.current.room.number).toBe(901);
  });

  it('leaves a re-read out of the queue outside the realm', () => {
    // A menu answers an Enter with a menu, so a claim on a room block that is
    // never coming would sit at the head of the queue and take the first real
    // arrival after logging in.
    const { tracker, feed } = session();
    tracker.observeReread();
    feed(['[HP=80/KAI=5]:', 'Location:            1,900', ...HERE_LINES]);
    expect(tracker.current.room.number).toBe(900);

    tracker.observeCommand('e');
    feed(EAST_LINES);
    expect(tracker.current.room.number).toBe(901);
    expect(tracker.pendingMoves).toBe(0);
  });

  it('gives a refusal the move, not the re-read queued in front of it', () => {
    /*
     * The one in-game bare Enter in 2,778 recorded ones that the server never
     * answered. Left at the head of the queue it would swallow the refusal
     * that belongs to the step behind it, and the step would then be answered
     * by the *next* room block — the phantom-move failure in a new hat.
     */
    const { tracker, feed } = session();
    feed(['[HP=80/KAI=5]:', 'Location:            1,900', ...HERE_LINES]);
    tracker.observeReread();
    tracker.observeCommand('e');
    feed(['There is no exit in that direction!']);
    expect(tracker.pendingMoves).toBe(0);
    expect(tracker.current.room.number).toBe(900);
  });
});

describe('the session clock', () => {
  it('starts at the first status line and does not restart at the second', () => {
    const tracker = play(['[HP=31]: ', '[HP=30]: ']);
    // play() stamps lines at 1_700_000_000_000 + seq.
    expect(tracker.current.progress.realmEnteredAt).toBe(1_700_000_000_001);
  });
});

describe('who is in a gang', () => {
  /*
   * captures/076, a MajorMUD realm with fifteen gangs on. The gang follows
   * the title behind a double space, and glued into the title it put
   * `Squire  of EyeExploredDora` on the Realm card as a rank.
   */
  const WHO = [
    '         Current Adventurers',
    '         ===================',
    '         Assad IbnAbbas            -  Menace',
    '         Beaver IzCoo              -  Squire  of EyeExploredDora',
    "    Good Crown Jewels              -  Acolyte  of Est? I'm on it?",
    'Criminal Lyki NigNogLover          x  Rogue Priest  of EyeExploredDora',
    '    Good Nester TheDupe            -  Monk  of Old Guard',
    '         Khaine Rhayne             -  Spellslinger  of ~RaT HoUSe RaBBle~',
    // GreaterMUD, live (`npm run probe:who`, 2026-08-29): one space before `of`,
    // a two-word title, and the status flag still last.
    '         Vaelor                -  Kai Warrior of Mudengine S',
    '         Rand                  -  Apprentice of Mudengine',
    '[HP=10/MA=5]:'
  ];
  const entry = (tracker: CharacterTracker, name: string) =>
    tracker.current.online.find((who) => who.name === name);

  it('splits the gang out of the title on a who row', () => {
    const tracker = play(WHO);
    expect(entry(tracker, 'Beaver')).toMatchObject({ title: 'Squire', gang: 'EyeExploredDora' });
    expect(entry(tracker, 'Lyki')).toMatchObject({
      title: 'Rogue Priest',
      gang: 'EyeExploredDora'
    });
    expect(entry(tracker, 'Crown')).toMatchObject({ title: 'Acolyte', gang: "Est? I'm on it?" });
    expect(entry(tracker, 'Khaine')).toMatchObject({ gang: '~RaT HoUSe RaBBle~' });
    expect(entry(tracker, 'Assad')).toMatchObject({ title: 'Menace', gang: null });
  });

  it('reads the single-spaced form the live GreaterMUD realm prints', () => {
    const tracker = play(WHO);
    expect(entry(tracker, 'Vaelor')).toMatchObject({
      title: 'Kai Warrior',
      gang: 'Mudengine',
      flags: 'S'
    });
    expect(entry(tracker, 'Rand')).toMatchObject({
      title: 'Apprentice',
      gang: 'Mudengine',
      flags: null
    });
  });

  it('takes the gang a look prints onto the roster row', () => {
    const tracker = play([...WHO, '[ Assad IbnAbbas ] (Repentance)']);
    expect(entry(tracker, 'Assad')?.gang).toBe('Repentance');
    expect(entry(tracker, 'Assad')?.provisional).toBe(false);
  });

  it('adds somebody looked at whom no listing has reached, provisionally', () => {
    const tracker = play([...WHO, '[ Philipe Gaston ] (Old Guard)']);
    expect(entry(tracker, 'Philipe')).toMatchObject({ gang: 'Old Guard', provisional: true });
  });
});

describe("the counter's own listing", () => {
  /* Jael's Missile Weapons, live 2026-08-27. */
  const LIST = [
    'The following items are for sale here:',
    'Item                          Quantity    Price',
    '--------------------------------------------------------------',
    "shortbow                      25          20 gold crowns (You can't use)",
    "runed longbow                 1           20 platinum pieces (You can't use)",
    'sling                         3           Free',
    // Not seen on this realm; the shapes the coin patterns already accept
    // elsewhere, so a one-word or capitalised noun is not a row lost in silence.
    'pebble                        9           1 runic',
    'stone                         2           3 Gold Crowns',
    '[HP=10/MA=5]:'
  ];
  const ROOM = (name: string) => [name, 'Obvious exits: north', '[HP=10/MA=5]:'];

  it('is kept as the counter said it, note and quoted price included', () => {
    const tracker = play([...ROOM("Jael's Missile Weapons"), ...LIST]);
    expect(tracker.current.shopListing?.items).toEqual([
      { name: 'shortbow', quantity: 25, price: '20 gold crowns', note: "You can't use" },
      { name: 'runed longbow', quantity: 1, price: '20 platinum pieces', note: "You can't use" },
      { name: 'sling', quantity: 3, price: 'Free', note: null },
      { name: 'pebble', quantity: 9, price: '1 runic', note: null },
      { name: 'stone', quantity: 2, price: '3 Gold Crowns', note: null }
    ]);
  });

  /* A quotation belongs to the shop it was made in. */
  it('goes when another room completes', () => {
    const tracker = play([
      ...ROOM("Jael's Missile Weapons"),
      ...LIST,
      ...ROOM('Newhaven, Main Street')
    ]);
    expect(tracker.current.shopListing).toBeNull();
  });

  /* The entry probe's `rm` resolves the shop's own coordinates; that is not a move. */
  it('survives the room being placed by rm', () => {
    const tracker = play([
      ...ROOM("Jael's Missile Weapons"),
      ...LIST,
      'Location: 1,2140',
      '[HP=10/MA=5]:'
    ]);
    expect(tracker.current.shopListing?.items).toHaveLength(5);
  });
});

describe('lives, and the word for the load', () => {
  it('keeps the lives the stat sheet states and counts a gain onto them', () => {
    const tracker = play([
      'Name:   Rayzor              Lives/CP: 3/12',
      'Race:   Human      Exp:      1500   Perception:  20',
      'Class:  Warrior    Level:    4      Stealth:     10',
      'Hits:   98/400     Armour Class: 12/3   Thievery:    5',
      'Mana:   50/120     Spellcasting: 12     Traps:       3',
      '[HP=98/MA=50]:',
      'You gain 2 additional lives.'
    ]);
    expect(tracker.current.progress.lives).toBe(5);
  });

  /* An unknown plus two is not two. */
  it('does not count a gain before any sheet has stated a total', () => {
    const tracker = play(['[HP=98/MA=50]:', 'You gain 2 additional lives.']);
    expect(tracker.current.progress.lives).toBeNull();
  });

  it("keeps the server's own word for the load, from the listing and from the bare line", () => {
    const tracker = play([
      'You are carrying Nothing!',
      'You have no keys.',
      'Wealth: 0 copper farthings',
      'Encumbrance: 0/2400 - None [0%]',
      '[HP=98/MA=50]:'
    ]);
    expect(tracker.current.inventory).toMatchObject({
      encumbrance: 0,
      encumbranceMax: 2400,
      encumbranceWord: 'None'
    });
    const bare = play(['[HP=98/MA=50]:', 'Encumbrance: 500/3360 - Light [14%]']);
    expect(bare.current.inventory.encumbranceWord).toBe('Light');
  });
});

describe('the gang listing, through the whole tracker', () => {
  /*
   * Fed through `play`, which classifies and calls `apply` exactly as
   * `SessionManager` does. That matters here rather than being ceremony:
   * `apply` runs the reducer **and** `trackPlayers` on the same block, and the
   * bug this pins lived entirely in the composition of the two. A test that
   * called `withGangListing` on its own passed while the client did the
   * opposite.
   */
  const WHO = [
    'Title           Name                            Reputation Gang/Guild',
    'Squire          Vaelor                          Neutral    Valor',
    '[HP=334/KAI=27]:'
  ];
  const BG_SAYS_OFFLINE = [
    'Valor members (1)',
    'Vaelor                        28 Half-Ogre Mystic           ',
    '[HP=334/KAI=27]:'
  ];

  it('reads a level, race and class off the listing into the registry', () => {
    const tracker = play([...WHO, ...BG_SAYS_OFFLINE]);
    expect(tracker.current.players['vaelor']).toMatchObject({
      level: 28,
      race: 'Half-Ogre',
      className: 'Mystic'
    });
  });

  /*
   * The roster is stale by design between `who` listings — a departure this
   * client missed leaves the entry sitting there — and `trackPlayers` folds it
   * whole on every block. It used to fold `online: true` over the gang
   * listing's explicit `online: false` **within the same apply**, so a member
   * the listing had just called offline was reported online again before
   * anything could see otherwise: unknown answered with the reassuring value.
   *
   * The level assertion above is the positive control for this one — it proves
   * the same fold reached the registry, so a passing `online: false` cannot be
   * a listing that was never read.
   */
  it('keeps a member offline even while the roster still lists them', () => {
    const tracker = play([...WHO, ...BG_SAYS_OFFLINE]);
    expect(tracker.current.online.map((who) => who.name)).toContain('Vaelor');
    expect(tracker.current.players['vaelor']?.online).toBe(false);
  });

  // The other direction still works: a listing that marks somebody online says so.
  it('marks a member online when the listing does', () => {
    const tracker = play([
      ...WHO,
      'Valor members (1)',
      'Vaelor                        28 Half-Ogre Mystic       - Online [Leader]',
      '[HP=334/KAI=27]:'
    ]);
    expect(tracker.current.players['vaelor']?.online).toBe(true);
    expect(tracker.current.players['vaelor']?.gangRank).toBe('Leader');
  });

  /*
   * A row the pattern could not read is a member missing from the card, and the
   * header's count is the only thing that can say so — the server increments it
   * alongside each row it prints, so the two are equal by construction.
   */
  it('records that a listing was short when a row could not be read', () => {
    const tracker = play([
      'Valor members (3)',
      'Vaelor                        28 Half-Ogre Mystic       - Online [Leader]',
      '[HP=334/KAI=27]:'
    ]);
    expect(tracker.current.gangListing?.short).toBe(3);
  });

  it('records no shortfall when every row was read', () => {
    const tracker = play([
      'Valor members (1)',
      'Vaelor                        28 Half-Ogre Mystic       - Online [Leader]',
      '[HP=334/KAI=27]:'
    ]);
    expect(tracker.current.gangListing?.short).toBeNull();
  });

  /*
   * The 25-column case, which is the one that was silently dropped. The
   * level/race/class field is padded to 25, so a member whose field is exactly
   * that long leaves a single space before `- Online` instead of the run of
   * padding every shorter row has.
   */
  it('reads a row whose level, race and class exhaust the padding', () => {
    const tracker = play([
      'Valor members (2)',
      'Vaelor                        28 Half-Ogre Mystic       - Online [Leader]',
      'Zed                           100 Gaunt One Necromancer - Online ',
      '[HP=334/KAI=27]:'
    ]);
    expect(tracker.current.gangListing?.short).toBeNull();
    expect(tracker.current.players['zed']).toMatchObject({
      level: 100,
      race: 'Gaunt One',
      className: 'Necromancer'
    });
  });
});

describe('gang membership changing while playing', () => {
  /*
   * `who` first, so the character's own gang is known — `ownGang` reads it off
   * this character's own row, and until it lands nothing can be said about
   * somebody joining "your gang".
   */
  const WHO = [
    '[HP=334/KAI=27]:',
    // The stat sheet names this character. `ownGang` reads its gang off its own
    // row in the listing below, and it cannot find that row without the name.
    'Name: Vaelor    Lives/CP: 3/12',
    '[HP=334/KAI=27]:',
    '         Current Adventurers',
    '         ===================',
    '    Good Vaelor                -  Kai Warrior of Valor S',
    '    Good Rand                  -  Apprentice',
    '[HP=334/KAI=27]:'
  ];

  it('puts somebody who just joined into the gang, on the broadcast alone', () => {
    const tracker = play([...WHO, 'Rand just joined your gang.']);
    expect(tracker.current.players['rand']?.gang).toBe('Valor');
    // And on the roster too, which is the half `Remotes` reads.
    expect(tracker.current.online.find((who) => who.name === 'Rand')?.gang).toBe('Valor');
  });

  /*
   * The one that matters. Gang membership is a *permission* — the gang grant
   * answers `@` commands for whoever shares this character's gang — so a
   * departure has to take effect on the broadcast rather than at the next
   * `who`. Until it does, the client keeps answering somebody who has left.
   *
   * The join above is this test's positive control: it proves the same path
   * writes a gang, so a passing `null` cannot be a broadcast nothing read.
   */
  it('takes somebody who left back out of it, so the gang grant stops reaching them', () => {
    const tracker = play([...WHO, 'Rand just joined your gang.', 'Rand has left Valor.']);
    expect(tracker.current.players['rand']?.gang).toBeNull();
    expect(tracker.current.online.find((who) => who.name === 'Rand')?.gang).toBeNull();
  });

  /*
   * `<word> has left <anything>.` is loose enough to match prose on a realm
   * this client has not seen, so the gang it names is checked against the one
   * this character is in rather than trusted.
   */
  it('ignores a departure from a gang this character is not in', () => {
    const tracker = play([...WHO, 'Rand just joined your gang.', 'Rand has left Norway.']);
    expect(tracker.current.players['rand']?.gang).toBe('Valor');
  });

  // Nothing has said which gang this character is in, so nothing can be said
  // about somebody joining it.
  it("says nothing about a join before any listing has named this character's gang", () => {
    const tracker = play(['[HP=334/KAI=27]:', 'Rand just joined your gang.']);
    expect(tracker.current.players['rand']).toBeUndefined();
  });
});

/*
 * Captured live 2026-08-29: `buy flask` → 980 copper, `sell flask` → 275. Both
 * lines state an exact figure in the unit `Wealth:` is normalised into, and the
 * item already moved between the pack and the shop — the money did not, so a
 * shop trip left the purse describing the character as it was before it.
 */
describe('a shop trip moves the purse', () => {
  /*
   * `Wealth:` is a qualifier *inside* the inventory batch, not a line of its
   * own, so the purse is seeded the way the wire seeds it — with a listing.
   */
  const listing = (wealth: number): string[] => [
    'You are carrying crystal flask',
    'You have no keys.',
    `Wealth: ${wealth} copper farthings`,
    'Encumbrance: 885/4800 - Light [18%]',
    '[HP=334/KAI=27]:'
  ];
  const purse = (steps: string[], wealth = 103_056): number | null =>
    play([...listing(wealth), ...steps]).current.inventory.wealth;

  it('takes what a purchase cost', () => {
    expect(purse(['You just bought crystal flask for 980 copper farthings.'])).toBe(102_076);
  });

  it('adds what a sale paid', () => {
    expect(purse(['You sold crystal flask for 275 copper farthings.'])).toBe(103_331);
  });

  /*
   * Adding to an unknown purse would claim the transaction was the whole of
   * it — the refusal the coin pick-up already makes, for the same reason.
   */
  it('leaves an unread purse unread', () => {
    const tracker = play(['You just bought crystal flask for 980 copper farthings.']);
    expect(tracker.current.inventory.wealth).toBeNull();
  });

  /*
   * A sale against a stale total must never produce a negative purse: there is
   * no number a readout could mean by one.
   */
  it('floors at nothing rather than going negative', () => {
    expect(purse(['You just bought crystal flask for 980 copper farthings.'], 100)).toBe(0);
  });
});

/*
 * Looking at yourself.
 *
 * `l vae` prints the same equipment block a look at anybody else does, and for
 * three phases the slots in it went nowhere for the one character they were
 * actually about: a ring worn and then looked at still read `in use` on the
 * card. The transcript below is the reported one, live on GreaterMUD
 * (2026-08-30).
 */
describe('looking at this character', () => {
  /* The stat sheet, closed by its own prompt, so this character has a name to
     be recognised by — and so the batch is not still open when the look
     arrives. */
  const named = (...lines: string[]): string[] => [
    '[HP=334/KAI=27]:',
    'Name: Vaelor    Lives/CP: 3/12',
    '[HP=334/KAI=27]:',
    ...lines
  ];

  /** The reported transcript: three things worn, then `l vae`. */
  const SELF_LOOK = [
    '[ Vaelor ](Valor)',
    'Vaelor is a massive, Herculean Half-Ogre Mystic with no hair and black eyes.',
    '',
    'He is equipped with:',
    '',
    'skullcap                       (Head)',
    '<empty>                        (Ears)',
    'bone charm                     (Neck)',
    '<empty>                        (Hands)',
    'silver ring                    (Finger)',
    '<empty>                        (Finger)',
    '<empty>                        (Weapon Hand)',
    '',
    '[HP=334/KAI=27]:'
  ];

  const slots = (tracker: CharacterTracker): Record<string, string | null> =>
    Object.fromEntries(tracker.current.inventory.items.map((item) => [item.name, item.slot]));

  it('names the slot of everything it says is worn', () => {
    const tracker = play(
      named('You are carrying skullcap, bone charm, silver ring.', '[HP=334/KAI=27]:', ...SELF_LOOK)
    );
    expect(slots(tracker)).toEqual({
      skullcap: 'Head',
      'bone charm': 'Neck',
      'silver ring': 'Finger'
    });
    expect(tracker.current.inventory.items.every((item) => item.equipped)).toBe(true);
  });

  /*
   * The block lists kit, not the pack. An item it does not name is one this
   * character is not *wearing* — never one it does not have — so a look must
   * not empty the card.
   */
  it('leaves what it does not name in the pack', () => {
    const tracker = play(
      named(
        'You are carrying skullcap, a rusty dagger, silver ring.',
        '[HP=334/KAI=27]:',
        ...SELF_LOOK
      )
    );
    // The positive control: without it this passes just as well when the look
    // was never read at all, which is the shape half the slow assertions in
    // `SessionManager.test.ts` used to have.
    expect(slots(tracker)['silver ring']).toBe('Finger');
    expect(slots(tracker)['a rusty dagger']).toBeNull();
    expect(tracker.current.inventory.items.map((item) => item.name)).toContain('a rusty dagger');
  });

  /*
   * Something worn that no listing has ever put in the pack: the entry is
   * created rather than the fact dropped, which is the answer `withEquipped`
   * already gives for `You are now wearing …` before any `i`.
   */
  it('adds something worn that no listing has mentioned', () => {
    const tracker = play(named(...SELF_LOOK));
    expect(slots(tracker)).toEqual({
      skullcap: 'Head',
      'bone charm': 'Neck',
      'silver ring': 'Finger'
    });
  });

  /*
   * `<empty>` is proof the block enumerates, so something the client thought
   * was on is off. Without that proof — MajorMUD omits its bare slots — the
   * absence says nothing and the flag is left alone, because clearing on no
   * evidence is the reassuring guess this project refuses.
   */
  it('takes off what an enumerating block does not name', () => {
    const tracker = play(
      named('You are carrying padded helm (Head), silver ring.', '[HP=334/KAI=27]:', ...SELF_LOOK)
    );
    const helm = tracker.current.inventory.items.find((item) => item.name === 'padded helm');
    expect(helm).toMatchObject({ equipped: false, slot: null });
  });

  it('leaves it alone when the block omits its empty slots', () => {
    const tracker = play(
      named(
        'You are carrying padded vest (Torso), silver ring.',
        '[HP=334/KAI=27]:',
        '[ Vaelor ](Valor)',
        'He is equipped with:',
        '',
        'silver ring                    (Finger)',
        '[HP=334/KAI=27]:'
      )
    );
    // Positive control again: the ring the block *did* name must have moved,
    // or this is asserting that nothing happened because nothing ran.
    expect(slots(tracker)['silver ring']).toBe('Finger');
    const vest = tracker.current.inventory.items.find((item) => item.name === 'padded vest');
    expect(vest).toMatchObject({ equipped: true, slot: 'Torso' });
  });

  /*
   * The pack holds instances. With a spare beside the worn pair, the block's
   * one row is matched to the pair already in use — otherwise a look would take
   * the gloves off the hands and put the spare on them.
   */
  it('matches the instance already in use before its spare', () => {
    const tracker = play(
      named(
        'You are carrying padded gloves (Hands), padded gloves',
        '[HP=334/KAI=27]:',
        '[ Vaelor ](Valor)',
        'He is equipped with:',
        '',
        'padded gloves                  (Hands)',
        '[HP=334/KAI=27]:'
      )
    );
    expect(tracker.current.inventory.items).toEqual([
      { name: 'padded gloves', source: 'wire', slot: 'Hands', equipped: true, charges: null },
      { name: 'padded gloves', source: 'wire', slot: null, equipped: false, charges: null }
    ]);
  });

  /*
   * Remembered, so putting it back on names the slot with no `i` in between —
   * which is the whole point of a listing that teaches.
   */
  it('remembers the slot for the next time the item goes on', () => {
    const tracker = play(
      named(...SELF_LOOK, 'You have removed silver ring.', 'You are now wearing silver ring.')
    );
    expect(slots(tracker)['silver ring']).toBe('Finger');
  });

  /*
   * And it goes to the pack **instead of** the registry. `trackPlayers` files
   * everybody the roster lists except self, precisely so a name in the console
   * does not open a panel about the person reading it — and this path reached
   * `observe` directly, which put this character in the registry the moment it
   * looked at itself.
   */
  it('does not file this character among the other players', () => {
    const tracker = play(named(...SELF_LOOK));
    expect(tracker.current.players['vaelor']).toBeUndefined();
    // The roster entry is right and stays: this character is in the realm.
    expect(tracker.current.online.some((entry) => entry.name === 'Vaelor')).toBe(true);
  });

  /* Unknown is not "yes": with no name on file nothing may be claimed as self. */
  it('treats the look as somebody else while this character has no name', () => {
    const tracker = play(SELF_LOOK);
    expect(tracker.current.players['vaelor']?.equipment).toEqual([
      { name: 'skullcap', slot: 'Head' },
      { name: 'bone charm', slot: 'Neck' },
      { name: 'silver ring', slot: 'Finger' }
    ]);
    expect(tracker.current.inventory.items).toEqual([]);
  });
});

describe('looking at another player', () => {
  /* captures/034, and the format string at `Player.cs:5379`. */
  const LOOK = [
    '[ Pherough Heretic ] (Insurrected Angels)',
    'Pherough is a colossal, Herculean Dark-Elf Mystic with short white hair and',
    'He is equipped with:',
    '',
    'gilded robes                   (Torso)',
    'padded pants                   (Legs)',
    'black and white serpent ring   (Finger)',
    '[HP=334/KAI=27]:'
  ];

  it('files the equipment block against the player the look was about', () => {
    const tracker = play(LOOK);
    expect(tracker.current.players['pherough']?.equipment).toEqual([
      { name: 'gilded robes', slot: 'Torso' },
      { name: 'padded pants', slot: 'Legs' },
      { name: 'black and white serpent ring', slot: 'Finger' }
    ]);
  });

  /*
   * `(Weapon Hand)` is a two-word slot, and a single-word slot class dropped
   * four of the corpus's thirty-six blocks — losing the weapon, which is the
   * one item that decides what a fight with this person looks like.
   */
  it('reads a two-word slot', () => {
    const tracker = play([
      '[ Pherough Heretic ]',
      'He is equipped with:',
      '',
      'jeweled scimitar               (Weapon Hand)',
      '[HP=334/KAI=27]:'
    ]);
    expect(tracker.current.players['pherough']?.equipment).toEqual([
      { name: 'jeweled scimitar', slot: 'Weapon Hand' }
    ]);
  });

  /*
   * The header is built from a gendered pronoun (`Misc.GetGenderPronoun`), and
   * every one of the corpus's thirty-six blocks says `He is` — so a pattern
   * written from the captures alone would have read a quarter of the realm and
   * drawn an empty list for everybody else.
   */
  it('reads the header for every gender the server can print', () => {
    for (const header of [
      'She is equipped with:',
      'They are equipped with:',
      'It is equipped with:'
    ]) {
      const tracker = play([
        '[ Pherough Heretic ]',
        header,
        '',
        'gilded robes                   (Torso)',
        '[HP=334/KAI=27]:'
      ]);
      expect(tracker.current.players['pherough']?.equipment).toEqual([
        { name: 'gilded robes', slot: 'Torso' }
      ]);
    }
  });

  // An equipment block with no `[ Name ]` line above it names nobody, and a
  // list filed against the wrong person is a decision made from another
  // player's kit.
  it('refuses a block it cannot attribute', () => {
    const tracker = play([
      'He is equipped with:',
      '',
      'gilded robes                   (Torso)',
      '[HP=334/KAI=27]:'
    ]);
    expect(Object.keys(tracker.current.players)).toEqual([]);
  });

  /*
   * Live on GreaterMUD, 2026-08-29. Two things about this realm that the
   * corpus could not have taught, and both of them silenced the whole look:
   *
   *   - the gang follows the bracket with **no space** (`](Valor)`), where all
   *     25 corpus occurrences are MajorMUD's `] (Gang)`. No name meant no
   *     `lookedAt`, so the equipment block below it was refused as
   *     unattributable and the card said nobody had looked.
   *   - every slot is printed, the bare ones as `<empty>`. MajorMUD says the
   *     same by omitting the row and the corpus has no `<empty>` anywhere.
   */
  const LIVE_LOOK = [
    '[ Soul Guardian ](Valor)',
    'Soul is a thin, moderately built Human Warrior with no hair and black eyes. He',
    'moves sluggishly, and is quite unfriendly and aloof. Soul appears to be',
    'slightly dull and seems a little naive. He is unwounded.',
    '',
    'He is equipped with:',
    '',
    '<empty>                        (Head)',
    '<empty>                        (Ears)',
    'silk gloves                    (Hands)',
    '<empty>                        (Worn)',
    '<empty>                        (Weapon Hand)',
    '',
    '[HP=334/KAI=27]:'
  ];

  it('reads a gang printed hard against the bracket', () => {
    const tracker = play(LIVE_LOOK);
    expect(tracker.current.players['soul']?.gang).toBe('Valor');
  });

  it('keeps only the slots that hold something', () => {
    const tracker = play(LIVE_LOOK);
    expect(tracker.current.players['soul']?.equipment).toEqual([
      { name: 'silk gloves', slot: 'Hands' }
    ]);
  });

  /*
   * Somebody wearing nothing is a *looked at* answer, not an unlooked one. With
   * `<empty>` kept as an item the two were indistinguishable — eighteen items
   * called `<empty>` — and dropping the rows without keeping the timestamp
   * would collapse it the other way, into "nobody has looked".
   */
  it('distinguishes wearing nothing from never having been looked at', () => {
    const tracker = play([
      '[ Soul Guardian ](Valor)',
      'He is equipped with:',
      '',
      '<empty>                        (Head)',
      '<empty>                        (Weapon Hand)',
      '[HP=334/KAI=27]:'
    ]);
    expect(tracker.current.players['soul']?.equipment).toEqual([]);
    expect(tracker.current.players['soul']?.equipmentAt).not.toBeNull();
  });
});

describe('a who listing printed as columns', () => {
  /* captures/013: a MajorMUD realm with the gang in a column that wraps. */
  const COLUMNS = [
    'Slum Street, Intersection',
    'Obvious exits: north, south, east',
    '[HP=107/MA=22]:',
    'Title           Name                            Reputation Gang/Guild',
    '=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=',
    'Guardian        Arcain OfKells                  Neutral    Dukes of',
    'Khazarad',
    'Conjurer        Dorf Dodger                     Good       ThiefsOfPern',
    'Strider         Heretic Infidel                 Neutral    None',
    'Magician        IceFairy ImCold                 Neutral',
    'FuryOfTheForgotten',
    'Woodsman        Monarth Lodune               ga Lawful     Bendyn Weyr',
    '[HP=107/MA=22]:'
  ];
  const entry = (tracker: CharacterTracker, name: string) =>
    tracker.current.online.find((who) => who.name === name);

  it('reads the row, the gang column, and a gang wrapped mid-name or whole', () => {
    const tracker = play(COLUMNS);
    expect(entry(tracker, 'Arcain')).toMatchObject({
      title: 'Guardian',
      alignment: 'Neutral',
      gang: 'Dukes of Khazarad'
    });
    expect(entry(tracker, 'IceFairy')).toMatchObject({ gang: 'FuryOfTheForgotten' });
    expect(entry(tracker, 'Monarth')).toMatchObject({
      alignment: 'Lawful',
      flags: 'ga',
      gang: 'Bendyn Weyr'
    });
    expect(entry(tracker, 'Dorf')).toMatchObject({ alignment: 'Good', gang: 'ThiefsOfPern' });
  });

  /* `None` is the realm's own word for no gang, and null is how this client says it. */
  it('reads None as no gang', () => {
    expect(entry(play(COLUMNS), 'Heretic')?.gang).toBeNull();
  });

  /* The live false positive: a wrapped gang name is title case and one word,
     which is what a room name looks like, and it moved the character. */
  it('does not take a wrapped gang name for a room', () => {
    const tracker = play(COLUMNS);
    expect(tracker.current.room.name).toBe('Slum Street, Intersection');
  });
});

/*
 * The realm records a `Worn` code per item and the listing prints a word per
 * worn item, and neither says the other. A listing that names an item the
 * realm knows teaches the pair, realm-wide — so a pair of boots this session
 * never saw listed reads `(Feet)` the first time it goes on, with no `i`.
 *
 * And where **no** listing has ever taught the code, the realm file's own
 * reading of it stands in, marked `slotSource: 'realm'` so the card can say
 * whose word it is. A disagreement is not that case: two words for one code
 * is a code that does not decide the word here, and the realm's reading would
 * be a guess between them.
 */
describe('what the listing calls a worn slot, learned per Worn code', () => {
  /** Three pairs of boots on code 5 and a helm on code 2, as the realm would list them. */
  function bootsRealm(): WorldGraph {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-slots-'));
    const file = path.join(dir, 'rooms.jsonl.gz');
    const header = {
      v: 6,
      source: 'test',
      rooms: 0,
      generatedAt: 'x',
      items: [
        { id: 1, n: 'padded boots', type: 3, worn: 5 },
        { id: 2, n: 'leather boots', type: 3, worn: 5 },
        { id: 3, n: 'iron boots', type: 3, worn: 5 },
        { id: 4, n: 'padded helm', type: 3, worn: 2 }
      ]
    };
    fs.writeFileSync(file, zlib.gzipSync(JSON.stringify(header) + '\n'));
    const graph = WorldGraph.load(file);
    fs.rmSync(dir, { recursive: true, force: true });
    return graph;
  }

  /** A lore that remembers slot words in memory, through the shared rules. */
  function slotLore(): MobLore & { taught: Map<number, SlotLoreEntry> } {
    const taught = new Map<number, SlotLoreEntry>();
    return {
      ...NO_LORE,
      taught,
      slotWordsFor: (worn) => taught.get(worn)?.words ?? [],
      observeSlot: (worn, word, at) => {
        const next = learnSlot(taught.get(worn), word, at);
        if (next) taught.set(worn, next);
      }
    };
  }

  const LISTING = [
    '[HP=34]:',
    'You are carrying padded boots (Feet), padded helm (Head)',
    'You have no keys.',
    'Wealth: 0 copper farthings',
    'Encumbrance: 500/3360 - None [14%]',
    '[HP=34]:'
  ];

  it('names the slot of boots never listed worn, from a pair that was', () => {
    const lore = slotLore();
    const tracker = play([...LISTING, 'You are now wearing leather boots.'], bootsRealm(), lore);
    expect(lore.taught.get(5)?.words).toEqual(['Feet']);
    expect(lore.taught.get(2)?.words).toEqual(['Head']);
    const boots = tracker.current.inventory.items.find((i) => i.name === 'leather boots');
    expect(boots?.equipped).toBe(true);
    expect(boots?.slot).toBe('Feet');
  });

  it('learns from somebody else’s kit as readily as from its own', () => {
    const lore = slotLore();
    const tracker = play(
      [
        '[ Vaelor ]',
        'He is equipped with:',
        '',
        'iron boots                     (Feet)',
        '<empty>                        (Head)',
        '[HP=34]:',
        'You are now wearing leather boots.'
      ],
      bootsRealm(),
      lore
    );
    expect(lore.taught.get(5)?.words).toEqual(['Feet']);
    // `<empty>` is a bare slot, not an item, and teaches nothing about code 2.
    expect(lore.taught.get(2)).toBeUndefined();
    const boots = tracker.current.inventory.items.find((i) => i.name === 'leather boots');
    expect(boots?.slot).toBe('Feet');
  });

  /* Two words for one code is not a vote; the card goes back to `in use`. */
  it('refuses to name a slot the listings have disagreed about', () => {
    const lore = slotLore();
    lore.observeSlot(5, 'Boots', 1);
    const tracker = play([...LISTING, 'You are now wearing leather boots.'], bootsRealm(), lore);
    expect(lore.taught.get(5)?.words).toEqual(['Boots', 'Feet']);
    const boots = tracker.current.inventory.items.find((i) => i.name === 'leather boots');
    expect(boots?.equipped).toBe(true);
    expect(boots?.slot).toBeNull();
  });

  /*
   * The case the third rung exists for: a character that bought and wore its
   * first kit, with nothing listed and nothing taught. The realm file has said
   * `Worn: 5` the whole time, and the card read `in use` until an `i` — the
   * command the maintained listing exists to save.
   */
  it('falls back to the realm file’s own word for a code nothing has taught', () => {
    const lore = slotLore();
    const tracker = play(['[HP=34]:', 'You are now wearing leather boots.'], bootsRealm(), lore);
    const boots = tracker.current.inventory.items.find((i) => i.name === 'leather boots');
    expect(boots?.equipped).toBe(true);
    expect(boots?.slot).toBe('Feet');
    // And says whose word it is, because no listing has printed it.
    expect(boots?.slotSource).toBe('realm');
  });

  /* A listing's word carries no source: the server printed it. */
  it('marks nothing when a listing taught the code', () => {
    const lore = slotLore();
    const tracker = play([...LISTING, 'You are now wearing leather boots.'], bootsRealm(), lore);
    const boots = tracker.current.inventory.items.find((i) => i.name === 'leather boots');
    expect(boots?.slot).toBe('Feet');
    expect(boots?.slotSource).toBeUndefined();
  });

  /* Taking it off takes the word and its source with it. */
  it('drops the realm’s word when the item comes off', () => {
    const lore = slotLore();
    const tracker = play(
      ['[HP=34]:', 'You are now wearing leather boots.', 'You have removed leather boots.'],
      bootsRealm(),
      lore
    );
    const boots = tracker.current.inventory.items.find((i) => i.name === 'leather boots');
    expect(boots?.equipped).toBe(false);
    expect(boots?.slot).toBeNull();
    expect(boots?.slotSource).toBeUndefined();
  });

  it('says nothing about an item the realm does not know', () => {
    const lore = slotLore();
    const tracker = play([...LISTING, 'You are now wearing silk slippers.'], bootsRealm(), lore);
    const slippers = tracker.current.inventory.items.find((i) => i.name === 'silk slippers');
    expect(slippers?.equipped).toBe(true);
    expect(slippers?.slot).toBeNull();
  });

  /* The session's own memory of the exact item still answers first. */
  it('prefers where this very item was last listed over what the code says', () => {
    const lore = slotLore();
    lore.observeSlot(5, 'Feet', 1);
    const tracker = play(
      [
        '[HP=34]:',
        'You are carrying padded boots (Footwear)',
        'You have no keys.',
        'Wealth: 0 copper farthings',
        'Encumbrance: 500/3360 - None [14%]',
        '[HP=34]:',
        'You have removed padded boots.',
        'You are now wearing padded boots.'
      ],
      bootsRealm(),
      lore
    );
    const boots = tracker.current.inventory.items.find((i) => i.name === 'padded boots');
    expect(boots?.slot).toBe('Footwear');
  });
});

/*
 * A condition is what the server has said, three ways: nobody has said,
 * on, off. Only the two sentences move it, and leaving the realm forgets it.
 */
describe('what the server has said is wrong with the character', () => {
  it('starts unknown, goes on with the onset and off with the ending', () => {
    const tracker = play([
      '[HP=34]:',
      'Poison burns through your veins!',
      'Your legs are paralyzed!',
      'You are blind.'
    ]);
    expect(tracker.current.afflictions).toEqual({
      blind: 'yes',
      poisoned: 'yes',
      diseased: 'unknown',
      held: 'yes'
    });
    const later = play([
      '[HP=34]:',
      'Poison burns through your veins!',
      'The dizzying poison runs its course.',
      'You can see again!',
      'You can move again!'
    ]);
    expect(later.current.afflictions).toEqual({
      blind: 'no',
      poisoned: 'no',
      diseased: 'unknown',
      held: 'no'
    });
  });

  it('reads the disease, and not somebody else’s', () => {
    const tracker = play([
      '[HP=34]:',
      'SandTiger is inflicted with a hideous rotting disease!',
      'You are inflicted with a hideous rotting disease!',
      'The disease dies down.'
    ]);
    expect(tracker.current.afflictions.diseased).toBe('no');
  });

  it('forgets on leaving the realm', () => {
    const tracker = play(['[HP=34]:', 'You are blind.']);
    expect(tracker.current.afflictions.blind).toBe('yes');
    tracker.leaveRealm();
    expect(tracker.current.afflictions.blind).toBe('unknown');
  });
});

/*
 * The duration spells the wire has confirmed on this character. The cast
 * confirmation is the one onset signal the wire frames and names — the
 * per-spell onset sentences are unenumerable realm message data — and the
 * wear-off frames end it.
 */
describe('the duration spells confirmed on this character', () => {
  /** A realm that knows one duration spell and one instant one. */
  function spellWorld(): WorldGraph {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-spells-'));
    const file = path.join(dir, 'rooms.jsonl.gz');
    const header = JSON.stringify({
      v: 5,
      source: 'test',
      rooms: 0,
      generatedAt: 'x',
      spells: [
        { id: 1, n: 'bless', short: 'bls', mana: 5, dur: 100 },
        { id: 2, n: 'minor healing', short: 'mihe', mana: 4 }
      ]
    });
    fs.writeFileSync(file, zlib.gzipSync(header + '\n'));
    const graph = WorldGraph.load(file);
    fs.rmSync(dir, { recursive: true, force: true });
    return graph;
  }

  it('is established by the cast confirmation and ended by the wear-off', () => {
    const tracker = play(['[HP=34]:', 'You cast bless on yourself!']);
    expect(tracker.current.buffs).toHaveLength(1);
    expect(tracker.current.buffs[0]).toMatchObject({ spell: 'bless', by: null });
    const gone = play([
      '[HP=34]:',
      'You cast bless on yourself!',
      'The effects of bless wear off!'
    ]);
    expect(gone.current.buffs).toEqual([]);
  });

  it('records who blessed this character, for the wear-off notification', () => {
    const tracker = play(['[HP=34]:', 'Naji casts bless on you!']);
    expect(tracker.current.buffs[0]).toMatchObject({ spell: 'bless', by: 'Naji' });
  });

  it('tracks neither an instant amount nor a cast on somebody else', () => {
    const tracker = play([
      '[HP=34]:',
      'You cast major healing on yourself, healing 16 damage!',
      'Naji casts mend on Naji!',
      'You cast bless on Sir!'
    ]);
    expect(tracker.current.buffs).toEqual([]);
  });

  /*
   * The pre-cast announcement is not the confirmation: the cast can still
   * fizzle, and a buff recorded from it is a shield believed up for the whole
   * fallback clock while it may never have landed.
   */
  it('does not establish a buff from a moves-to-cast announcement', () => {
    const tracker = play([
      'Welcome back, Vaelor!',
      '[HP=34]:',
      'Naji moves to cast bless upon Vaelor.'
    ]);
    expect(tracker.current.name).toBe('Vaelor');
    expect(tracker.current.buffs).toEqual([]);
  });

  it('refreshes a recast rather than listing it twice', () => {
    const tracker = play([
      '[HP=34]:',
      'You cast bless on yourself!',
      'You cast bless on yourself!'
    ]);
    expect(tracker.current.buffs).toHaveLength(1);
  });

  it('asks the realm whether the spell lasts, where the realm can say', () => {
    // The realm states a duration: tracked.
    expect(
      play(['[HP=34]:', 'You cast bless on yourself!'], spellWorld()).current.buffs
    ).toHaveLength(1);
    // The realm knows the spell and states none: an instant, not a buff.
    expect(
      play(['[HP=34]:', 'You cast minor healing on yourself!'], spellWorld()).current.buffs
    ).toEqual([]);
    // A spell the realm cannot name is kept — a derivative realm's buff is
    // still a buff, and the fallback clock bounds its life.
    expect(
      play(['[HP=34]:', 'You cast strange glow on yourself!'], spellWorld()).current.buffs
    ).toHaveLength(1);
  });

  it('matches a wear-off through the realm table, so two spellings are one spell', () => {
    const tracker = play(
      ['[HP=34]:', 'You cast bls on yourself!', 'The effects of bless wear off!'],
      spellWorld()
    );
    expect(tracker.current.buffs).toEqual([]);
  });

  it('leaves the list alone for a wear-off naming nothing on it', () => {
    const tracker = play([
      '[HP=34]:',
      'You cast bless on yourself!',
      "The effects of the mummy's curse wears off!"
    ]);
    expect(tracker.current.buffs).toHaveLength(1);
  });

  it('dies with the character, and does not survive leaving the realm', () => {
    const dead = play(['[HP=34]:', 'You cast bless on yourself!', 'You have been killed!']);
    expect(dead.current.buffs).toEqual([]);
    const left = play(['[HP=34]:', 'You cast bless on yourself!']);
    expect(left.current.buffs).toHaveLength(1);
    left.leaveRealm();
    expect(left.current.buffs).toEqual([]);
  });
});

/*
 * What a party member is fighting, from the sentences the server volunteers
 * about other people's blows — the fact `automation.party.assistLeader` acts
 * on. Only a member; only a target that is not this character or a person.
 */
describe('what a party member was last seen fighting', () => {
  /* The listing puts Soul in the party, and the follow sentence makes them the leader. */
  const inParty = [
    '[HP=33]:',
    'The following people are in your travel party:',
    '  Vaelor                        (Warrior)             [H:100%]  - Frontrank',
    '  Soul                          (Paladin)    [M:100%] [H:100%]  - Backrank',
    '[HP=33]:',
    'You are following Soul.'
  ];

  it('records the leader’s target from an opening on a monster', () => {
    const tracker = play([...inParty, 'Soul moves to attack giant rat!']);
    expect(tracker.current.party.following).toBe('Soul');
    expect(tracker.current.party.engaged['Soul']?.target).toBe('giant rat');
  });

  it('ignores somebody outside the party, and a blow on this character', () => {
    const tracker = play([
      ...inParty,
      'Rend moves to attack giant rat!',
      'Soul moves to attack you!'
    ]);
    expect(Object.keys(tracker.current.party.engaged)).toEqual([]);
  });

  /*
   * The same sentences read the other way round: what is attacking a member —
   * the fact `automation.party.defendParty` acts on. `engaged` is the fight a
   * member chose; this is the fight brought to them, and a member being
   * pummelled without swinging back is exactly the case defending exists for.
   */
  it('records a monster’s blow on a member, with the article dropped', () => {
    const tracker = play([...inParty, 'The massive ice dragon snaps at Soul with its fangs!']);
    expect(tracker.current.party.threatened['Soul']?.target).toBe('massive ice dragon');
    // And the member's own fight is untouched: Soul has not swung.
    expect(tracker.current.party.engaged['Soul']).toBeUndefined();
  });

  /* A member swinging is `engaged`'s fact, never a threat to the target. */
  it('never records a member as the attacker', () => {
    const tracker = play([...inParty, 'Soul swings at Vaelor with his axe!']);
    expect(Object.keys(tracker.current.party.threatened)).toEqual([]);
  });

  it('ignores a blow on somebody outside the party', () => {
    const tracker = play([...inParty, 'The giant rat claws at Rend with its claws!']);
    expect(Object.keys(tracker.current.party.threatened)).toEqual([]);
  });
});

/*
 * The registry used to die with the session, and the Worn tab said *nobody has
 * looked at Soul yet* about a player looked at the evening before by another
 * character. What the realm knows about a player is seeded in, remembered as
 * it changes, and absorbed from the other sessions on the realm.
 */
describe('what the realm remembers about a player', () => {
  const LOOK = [
    '[ Soul Guardian ](Valor)',
    'He is equipped with:',
    '',
    'silk gloves                    (Hands)',
    '[HP=334/KAI=27]:'
  ];

  /** A realm's book, in memory: what a session remembers is what the next one recalls. */
  function realm(seed: readonly PlayerFacts[] = []) {
    const held = new Map(seed.map((facts) => [facts.name.toLowerCase(), facts]));
    const remembered: PlayerFacts[] = [];
    const view: RealmPlayers = {
      recall: () => [...held.values()],
      remember: (facts) => {
        remembered.push(facts);
        held.set(facts.name.toLowerCase(), facts);
      },
      subscribe: () => () => {}
    };
    return { view, remembered, held };
  }

  it('tells the realm what a look showed, and only the facts about the player', () => {
    const { view, remembered, held } = realm();
    play(LOOK, undefined, undefined, undefined, view);
    // What the realm *holds* is the record to read: a look is remembered as
    // its parts arrive, and the last of them carries the whole.
    expect(remembered.length).toBeGreaterThan(0);
    const soul = held.get('soul');
    expect(soul).toMatchObject({
      gang: 'Valor',
      equipment: [{ name: 'silk gloves', slot: 'Hands' }]
    });
    expect(soul?.equipmentAt).not.toBeNull();
    // Whether *this* session has seen them online is not the realm's to say.
    expect(soul).not.toHaveProperty('online');
    expect(soul).not.toHaveProperty('inParty');
  });

  it('starts a fresh session on the realm already knowing the kit, and nobody online', () => {
    const { view } = realm();
    play(LOOK, undefined, undefined, undefined, view);

    const next = new CharacterTracker(undefined, undefined, undefined, undefined, view);
    expect(next.current.players['soul']).toMatchObject({
      equipment: [{ name: 'silk gloves', slot: 'Hands' }],
      gang: 'Valor',
      online: false,
      inParty: false
    });
  });

  /* A reconnect is a new session on the same realm, not a new realm. */
  it('seeds the realm back in on reset', () => {
    const { view } = realm();
    const tracker = play(LOOK, undefined, undefined, undefined, view);
    tracker.reset();
    expect(tracker.current.players['soul']?.equipment).toEqual([
      { name: 'silk gloves', slot: 'Hands' }
    ]);
    expect(tracker.current.players['soul']?.online).toBe(false);
  });

  it('absorbs what another session learned, says whether it changed, and never hands it back', () => {
    const { view, remembered } = realm();
    const tracker = new CharacterTracker(undefined, undefined, undefined, undefined, view);
    const seen: PlayerFacts = {
      name: 'Soul',
      alignment: null,
      title: null,
      gang: 'Valor',
      level: null,
      race: null,
      className: null,
      gangRank: null,
      equipment: [{ name: 'gilded robes', slot: 'Torso' }],
      equipmentAt: 1_700_000_000_500,
      lastRoom: null,
      lastRoomName: null,
      lastRoomAt: null,
      lastSeen: 1_700_000_000_500,
      vitals: null,
      vitalsAt: null
    };
    expect(tracker.absorbPlayers([seen])).toBe(true);
    expect(tracker.current.players['soul']?.equipment).toEqual(seen.equipment);
    expect(tracker.absorbPlayers([seen])).toBe(false);
    expect(remembered).toEqual([]);
  });
});

/*
 * Dying takes everything off and leaves it in the pack, and at that moment
 * `CarriedItem.slot` is null on every item — a slot is where the *listing* said
 * something sits, and the listing no longer says. So a character standing up
 * after a death has a pack full of kit and nothing that knows which helm was on
 * its head. `CharacterState.loadout` is the memory that answers that.
 */
describe('what was in each worn slot', () => {
  const feeder = () => {
    const classifier = new Classifier();
    const tracker = new CharacterTracker();
    let seq = 0;
    const feed = (text: string): void => {
      seq += 1;
      const { block, batch } = classifier.classify({
        seq,
        at: 1_700_000_000_000 + seq,
        text,
        plain: text,
        terminator: 'newline'
      });
      tracker.apply(block);
      if (batch) tracker.apply(batch, batch.rows);
    };
    return { tracker, feed };
  };

  /* The listing is the only thing that states a slot. */
  const listing = (feed: (t: string) => void, carrying: string): void => {
    feed(`You are carrying ${carrying}`);
    feed('You have no keys.');
    feed('Wealth: 0 copper farthings');
    feed('Encumbrance: 868/4800 - Light [18%]');
    feed('[HP=334/KAI=27]:');
  };

  it('is learned from a listing that names a slot', () => {
    const { tracker, feed } = feeder();
    listing(feed, 'padded helm (Head), rope');
    expect(tracker.current.loadout).toEqual([
      { slot: 'Head', item: 'padded helm', at: expect.any(Number) }
    ]);
  });

  /* The state this exists for: everything off, everything still in the pack. */
  it('survives the kit coming off', () => {
    const { tracker, feed } = feeder();
    listing(feed, 'padded helm (Head)');
    listing(feed, 'padded helm');
    expect(tracker.current.inventory.items[0]?.equipped).toBe(false);
    expect(tracker.current.loadout).toHaveLength(1);
  });

  it('follows a swap made by hand', () => {
    const { tracker, feed } = feeder();
    listing(feed, 'padded helm (Head)');
    listing(feed, 'iron helm (Head), padded helm');
    expect(tracker.current.loadout).toEqual([
      { slot: 'Head', item: 'iron helm', at: expect.any(Number) }
    ]);
  });

  it('has none before a listing has named one', () => {
    const { tracker } = feeder();
    expect(tracker.current.loadout).toEqual([]);
  });

  /*
   * Restored at `reset()` from the character's own record, beside the
   * balances, and for the same reason: a reconnect is a new session and has to
   * be seeded like the first one.
   */
  it('is restored from the record on a new connection', () => {
    const kept = [{ slot: 'Head', item: 'padded helm', at: 1_600_000_000_000 }];
    const { tracker } = feeder();

    tracker.useBelongings({ ...NO_BELONGINGS, recallLoadout: () => kept });
    tracker.reset();

    expect(tracker.current.loadout).toEqual(kept);
  });

  it('writes a slot down the moment a listing names one', () => {
    const written: string[][] = [];
    const { tracker, feed } = feeder();

    tracker.useBelongings({
      ...NO_BELONGINGS,
      rememberLoadout: (loadout) => written.push(loadout.map((worn) => worn.item))
    });
    listing(feed, 'padded helm (Head)');
    // The same listing again: nothing moved, so nothing is written.
    listing(feed, 'padded helm (Head)');

    expect(written).toEqual([['padded helm']]);
  });
});

/*
 * A portal step on a route — `dive pool`, `go vortex` — is a scripted teleport
 * to exact coordinates. The walker hints the command and the destination
 * before sending it; the arriving room then resolves by the coordinates the
 * script states, never by an exit that does not exist. 46 of the shipped
 * realm's 60 routable portals land in the dark, so the dark arrival is the
 * ordinary case, not the edge.
 */
/**
 * Where we came from.
 *
 * The client had this fact and threw it away. `Walker.recent` held a copy, of
 * the walker's own confirmed steps only, and the escape asked *that* — so
 * measured on 2026-09-02 (`logs/2026-09-02_21-04-28_festus.mudcap.jsonl`,
 * t=418517) a loop sent `n`, a giant bat re-opened combat 2ms later and stopped
 * the walk, the room arrived 1,244ms after that, and the step that had actually
 * moved the character was never recorded. The escape then reported *no
 * confirmed step to retrace from here* while standing in `Graveyard,
 * North-West Corner`, which it had walked into itself a minute earlier, with
 * `Obvious exits: south, east` on the screen.
 *
 * So it is the tracker's: a room block resolving against a queued move is the
 * moment the fact exists, and every move goes through it whoever caused it.
 */
describe('the way back', () => {
  const WEST = { m: 1, r: 1, n: 'Western Edge', x: { n: { m: 1, r: 2 } } };
  const NORTH = { m: 1, r: 2, n: 'North-West Corner', x: { s: { m: 1, r: 1 }, e: { m: 1, r: 3 } } };
  const EAST = { m: 1, r: 3, n: 'North Wall', x: { w: { m: 1, r: 2 } } };

  function graveyard(): WorldGraph {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-trail-'));
    const file = path.join(dir, 'rooms.jsonl.gz');
    const rooms = [WEST, NORTH, EAST];
    const header = JSON.stringify({ v: 1, source: 'test', rooms: rooms.length, generatedAt: 'x' });
    fs.writeFileSync(
      file,
      zlib.gzipSync([header, ...rooms.map((room) => JSON.stringify(room))].join('\n') + '\n')
    );
    const graph = WorldGraph.load(file);
    fs.rmSync(dir, { recursive: true, force: true });
    return graph;
  }

  function session(): {
    tracker: CharacterTracker;
    feed: (lines: string[]) => void;
    send: (command: string) => void;
  } {
    const tracker = new CharacterTracker(graveyard());
    const classifier = new Classifier({
      present: () => tracker.current.room.occupants.map((who) => who.name),
      mob: () => undefined
    });
    let seq = 0;
    const feed = (lines: string[]): void => {
      for (const plain of lines) {
        seq += 1;
        const line: StreamLine = {
          seq,
          at: 1_700_000_000_000 + seq,
          text: plain,
          plain,
          terminator: 'newline'
        };
        const { block, batch } = classifier.classify(line);
        tracker.apply(block);
        if (batch) tracker.apply(batch);
      }
    };
    const send = (command: string): void => {
      tracker.observeCommand(command);
      classifier.observeCommand(command);
    };
    feed(['[HP=62]:', 'Western Edge', 'Obvious exits: north']);
    return { tracker, feed, send };
  }

  it('records the move and offers its reverse from the room it landed in', () => {
    const { tracker, feed, send } = session();
    send('n');
    feed(['North-West Corner', 'Obvious exits: south, east']);
    expect(tracker.current.room.number).toBe(2);
    expect(tracker.trail).toEqual([{ from: '1/1', direction: 'n', to: '1/2' }]);
    expect(tracker.wayBackFrom('1/2')).toMatchObject({ from: '1/1', direction: 'n', to: '1/2' });
  });

  /*
   * The step that mattered in the capture was a *loop's*, and the walker never
   * confirmed it because combat stopped the walk first. Nothing here is a
   * walker: a typed direction and an automated one reach the tracker through
   * the same call, which is the whole reason the fact lives here.
   */
  it('does not care who sent the move', () => {
    const { tracker, feed, send } = session();
    send('n');
    feed(['*Combat Engaged*', 'North-West Corner', 'Obvious exits: south, east']);
    expect(tracker.wayBackFrom('1/2')?.direction).toBe('n');
  });

  /* The opposite of a step taken from somewhere else leads somewhere else. */
  it('offers nothing from a room the newest move did not end in', () => {
    const { tracker, feed, send } = session();
    send('n');
    feed(['North-West Corner', 'Obvious exits: south, east']);
    expect(tracker.wayBackFrom('1/1')).toBeNull();
    expect(tracker.wayBackFrom('1/3')).toBeNull();
  });

  /* A room block nobody asked for moved nothing: the server reprints unasked. */
  it('writes nothing down for a room that answers no move', () => {
    const { tracker, feed } = session();
    feed(['Western Edge', 'Obvious exits: north']);
    expect(tracker.trail).toEqual([]);
  });

  /*
   * A teleport arrives along no edge, so it has no opposite to state. Guessing
   * one sends a character somewhere it may not come back from — the same rule
   * the walker's own portal handling keeps.
   */
  it('writes nothing down for a teleport', () => {
    const { tracker, feed } = session();
    tracker.hintTeleport('dive pool', 1, 3);
    tracker.observeCommand('dive pool');
    feed(['North Wall', 'Obvious exits: west']);
    expect(tracker.current.room.number).toBe(3);
    expect(tracker.trail).toEqual([]);
  });

  /*
   * The realm puts a dead character in its area's temple, along no edge — and
   * the newest step on the trail is the one that walked into whatever did the
   * killing, which is the last direction any escape should offer.
   */
  it('forgets the whole trail when the character dies', () => {
    const { tracker, feed, send } = session();
    send('n');
    feed(['North-West Corner', 'Obvious exits: south, east']);
    expect(tracker.trail).toHaveLength(1);
    feed(['You have been killed!']);
    expect(tracker.trail).toEqual([]);
  });

  /* And a new connection is a new journey: nothing behind it is one room away. */
  it('forgets it on a reset', () => {
    const { tracker, feed, send } = session();
    send('n');
    feed(['North-West Corner', 'Obvious exits: south, east']);
    tracker.reset();
    expect(tracker.trail).toEqual([]);
  });

  /* Bounded, like every other trace this client keeps. */
  it('keeps only the last few steps', () => {
    const { tracker, feed, send } = session();
    for (let lap = 0; lap < 6; lap += 1) {
      send('n');
      feed(['North-West Corner', 'Obvious exits: south, east']);
      send('s');
      feed(['Western Edge', 'Obvious exits: north']);
    }
    expect(tracker.trail.length).toBeLessThanOrEqual(TUNING.walk.recentSteps);
    expect(tracker.wayBackFrom('1/1')?.direction).toBe('s');
  });
});

describe('a scripted teleport the walker hinted', () => {
  const SHORE = { m: 1, r: 1, n: 'Shore', x: { e: { m: 1, r: 2 } } };
  const BEACH = { m: 1, r: 2, n: 'East Beach', x: { w: { m: 1, r: 1 } } };
  const CAVERN = { m: 2, r: 1, n: 'Far Cavern', x: { w: { m: 2, r: 3 } } };
  const HOLLOW = { m: 2, r: 3, n: 'Hollow', x: {} };
  const PIT = { m: 2, r: 2, n: 'Black Pit', li: -200, x: {} };

  function portalWorld(): WorldGraph {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-portal-'));
    const file = path.join(dir, 'rooms.jsonl.gz');
    const rooms = [SHORE, BEACH, CAVERN, HOLLOW, PIT];
    const header = JSON.stringify({ v: 1, source: 'test', rooms: rooms.length, generatedAt: 'x' });
    fs.writeFileSync(
      file,
      zlib.gzipSync([header, ...rooms.map((room) => JSON.stringify(room))].join('\n') + '\n')
    );
    const graph = WorldGraph.load(file);
    fs.rmSync(dir, { recursive: true, force: true });
    return graph;
  }

  function session(): {
    tracker: CharacterTracker;
    feed: (lines: string[]) => void;
    send: (command: string) => void;
  } {
    const tracker = new CharacterTracker(portalWorld());
    // Wired the way `SessionManager` wires it: a combat line carries the
    // monster's name inside realm-supplied words, and only the room can say
    // where it ends.
    const classifier = new Classifier({
      present: () => tracker.current.room.occupants.map((who) => who.name),
      mob: () => undefined
    });
    let seq = 0;
    const feed = (lines: string[]): void => {
      for (const plain of lines) {
        seq += 1;
        const line: StreamLine = {
          seq,
          at: 1_700_000_000_000 + seq,
          text: plain,
          plain,
          terminator: 'newline'
        };
        const { block, batch } = classifier.classify(line);
        tracker.apply(block);
        if (batch) tracker.apply(batch);
      }
    };
    const send = (command: string): void => {
      tracker.observeCommand(command);
      classifier.observeCommand(command);
    };
    feed(['[HP=62]:', 'Shore', 'Obvious exits: east']);
    return { tracker, feed, send };
  }

  it('resolves a named arrival by the coordinates the script stated', () => {
    const { tracker, feed, send } = session();
    tracker.hintTeleport('dive pool', 2, 1);
    send('dive pool');
    // Counted as a move while in flight: the walk and loop desynchronisation
    // guards must hold across a teleport exactly as across a step.
    expect(tracker.pendingMoves).toBe(1);
    feed(['Far Cavern', 'Obvious exits: west']);
    expect(tracker.current.room.map).toBe(2);
    expect(tracker.current.room.number).toBe(1);
    expect(tracker.current.room.resolvedBy).toBe('coordinates');
    expect(tracker.pendingMoves).toBe(0);
  });

  it('resolves a dark arrival the same way, when the realm agrees it is dark', () => {
    const { tracker, feed, send } = session();
    tracker.hintTeleport('jump pit', 2, 2);
    send('jump pit');
    feed(["The room is pitch black - you can't see anything"]);
    expect(tracker.current.room.map).toBe(2);
    expect(tracker.current.room.number).toBe(2);
    expect(tracker.current.room.resolvedBy).toBe('coordinates');
    expect(tracker.pendingMoves).toBe(0);
  });

  /*
   * The server saying the phrase out loud is what it does with a word it will
   * not run. The refusal must disarm the promised coordinates, or the next
   * named room would be resolved to somewhere nobody went.
   */
  it('disarms the coordinates when the server refuses the command', () => {
    const { tracker, feed, send } = session();
    tracker.hintTeleport('dive pool', 2, 1);
    send('dive pool');
    feed(['You say "dive pool"']);
    expect(tracker.pendingMoves).toBe(0);
    send('e');
    feed(['East Beach', 'Obvious exits: west']);
    expect(tracker.current.room.map).toBe(1);
    expect(tracker.current.room.number).toBe(2);
  });

  /*
   * A step taken leaves the fight's participants behind, and a portal is a
   * step: 14 of the 60 routable teleports land lit, take the coordinate
   * branch, and used to carry `attackers` two maps — retaliation then swung
   * at a monster standing somewhere else entirely.
   */
  it('leaves the fight behind on a teleport-resolved arrival', () => {
    const { tracker, feed, send } = session();
    feed(['Also here: giant rat.', 'Obvious exits: east', 'The giant rat bites you for 3 damage!']);
    expect(tracker.current.combat.attackers).toEqual(['giant rat']);
    tracker.hintTeleport('dive pool', 2, 1);
    send('dive pool');
    feed(['Far Cavern', 'Obvious exits: west']);
    expect(tracker.current.room.number).toBe(1);
    expect(tracker.current.combat.attackers).toEqual([]);
    expect(tracker.current.combat.target).toBeNull();
  });

  /*
   * "Nothing moved, so nowhere changed" must not swallow a portal arrival
   * whose name line the classifier could not read: a teleport is a move, and
   * a move may honestly report that it does not know where it landed.
   */
  it('does not keep the old room across a teleport whose name went unread', () => {
    const { tracker, feed, send } = session();
    expect(tracker.current.room.number).toBe(1);
    tracker.hintTeleport('dive pool', 2, 1);
    send('dive pool');
    // A nameless completed room: the name line was prose the classifier
    // refused, and only the exits arrived.
    feed(['Obvious exits: west']);
    expect(tracker.current.room.map).toBeNull();
    expect(tracker.current.room.number).toBeNull();
  });

  it('a typed direction supersedes the hint, exactly as it supersedes a move hint', () => {
    const { tracker, feed, send } = session();
    tracker.hintTeleport('dive pool', 2, 1);
    send('e');
    feed(['East Beach', 'Obvious exits: west']);
    // The hint was never spent, and the typed move resolved normally.
    expect(tracker.current.room.number).toBe(2);
    // Sending the phrase now queues nothing: the hint is gone.
    send('dive pool');
    expect(tracker.pendingMoves).toBe(0);
  });
});

/*
 * The spellbook: what the `sp` / `pow` listing said this character knows.
 * Wire shapes from `npm run probe:spellbook` (2026-09-01). The listing is
 * authoritative — it replaces the whole book — and null is *never read*,
 * which is not the same as knowing nothing.
 */
describe('the spellbook', () => {
  const powers = [
    '[HP=334/KAI=27]:',
    'You have the following powers:',
    'Level Kai  Short Spell Name',
    '  2   1    swan  way of the swan',
    ' 10   6    mant  way of the mantis',
    '[HP=334/KAI=27]:'
  ];

  it('starts unread, and unread is not empty', () => {
    expect(play(['[HP=34]:']).current.spellbook).toBeNull();
  });

  it('is read whole from the listing, and the header restates the resource', () => {
    const tracker = play(powers);
    expect(tracker.current.spellbook).toEqual([
      { name: 'way of the swan', short: 'swan', level: 2, cost: 1 },
      { name: 'way of the mantis', short: 'mant', level: 10, cost: 6 }
    ]);
    expect(tracker.current.vitals.manaType).toBe('KAI');
  });

  it('is replaced by the next listing, never merged', () => {
    const tracker = play([
      ...powers,
      'You have the following spells:',
      'Level Mana Short Spell Name',
      '  1   1    harm  harm',
      '[HP=33/MA=22]:'
    ]);
    expect(tracker.current.spellbook).toEqual([{ name: 'harm', short: 'harm', level: 1, cost: 1 }]);
  });

  it('appends a learned power onto a read book, once, and never onto an unread one', () => {
    const learned = play([...powers, 'You have learned a new power way of the owl!']);
    expect(learned.current.spellbook?.at(-1)).toEqual({
      name: 'way of the owl',
      short: null,
      level: null,
      cost: null
    });
    const again = play([
      ...powers,
      'You have learned a new power way of the owl!',
      'You have learned a new power way of the owl!'
    ]);
    expect(again.current.spellbook).toHaveLength(3);
    /*
     * A learn with no listing behind it stays off the state: a book of one
     * would read as "knows nothing else" to everything downstream. The
     * asking routine re-asks instead, and the listing that answers is whole.
     */
    expect(
      play(['[HP=34]:', 'You have learned a new power way of the owl!']).current.spellbook
    ).toBeNull();
  });

  it('reads the resource word off the stat sheet, even where the prompt omits it', () => {
    const tracker = play([
      'Name:   Daytona             Lives/CP: 3/12',
      'Race:   Human      Exp:      1500   Perception:  20',
      'Class:  Mystic     Level:    4      Stealth:     10',
      'Hits:   58/72      Armour Class: 12/3   Thievery:    5',
      'Kai:    27/27      Spellcasting: 0      Traps:       0',
      '[HP=58]: '
    ]);
    expect(tracker.current.vitals.manaType).toBe('KAI');
    expect(tracker.current.vitals.manaMax).toBe(27);
  });
});

/*
 * Reading a scroll: two facts in one sentence, and the second one is not in it.
 *
 * Captured live 2026-09-03 — `bu harm`, `bu minor`, then `read harm` and
 * `read minor`, answered by `You add harm to your spellbook!` and `You add
 * minor healing to your spellbook!`. The server names the *spell*, expanded
 * from whatever prefix was typed, and never the scroll; the link back to the
 * item is `Items.Abil-n` holding `LearnSp` with the `Spells` row id beside it.
 *
 * These run against the shipped realm because that link is the thing under
 * test: `scroll of cause harm` carries `[42, 12]` and spell 12 is `harm`,
 * `scroll of minor healing` carries `[42, 13]` and spell 13 is `minor
 * healing`. Those are exactly the two names the wire printed, which is what
 * makes this reading confirmed rather than inferred from another client's enum.
 */
describe.runIf(realm !== null && realm.size > 0)('reading a spell off a scroll', () => {
  /** Two scrolls and something that teaches nothing, then a book to append to. */
  const shelf = [
    '[HP=40/MA=8]:',
    'You are carrying scroll of cause harm, scroll of minor healing, a torch.',
    'You have no keys.',
    'Wealth: 40 copper farthings',
    '[HP=40/MA=8]:',
    'You have the following spells:',
    'Level Mana Short Spell Name',
    '  1   1    harm  harm',
    '[HP=40/MA=8]:'
  ];

  const carried = (tracker: CharacterTracker): string[] =>
    tracker.current.inventory.items.map((item) => item.name);

  it('adds the spell and spends the one scroll that taught it', () => {
    const tracker = play(
      [...shelf, 'You add minor healing to your spellbook!'],
      realm ?? undefined
    );

    expect(tracker.current.spellbook).toEqual([
      { name: 'harm', short: 'harm', level: 1, cost: 1 },
      // The realm's own columns, so an appended spell is as complete as a
      // listed one rather than three nulls waiting on the next `sp`.
      { name: 'minor healing', short: 'mihe', level: 1, cost: 2 }
    ]);
    // The *other* scroll is untouched: the spell decides which item went.
    expect(carried(tracker)).toEqual(['scroll of cause harm', 'a torch']);
  });

  it('spends nothing when no carried item teaches that spell', () => {
    const tracker = play([...shelf, 'You add bless to your spellbook!'], realm ?? undefined);

    expect(tracker.current.spellbook?.at(-1)?.name).toBe('bless');
    expect(carried(tracker)).toEqual([
      'scroll of cause harm',
      'scroll of minor healing',
      'a torch'
    ]);
  });

  /*
   * The two halves are independent. A character who has never typed `sp` has
   * no book to append to -- one spell appended to `null` would publish a book
   * of one -- but the scroll is gone from the pack either way, because that is
   * a fact about the pack and not about the book.
   */
  it('spends the scroll even with no book read, and still publishes no book', () => {
    const tracker = play(
      [
        '[HP=40/MA=8]:',
        'You are carrying scroll of minor healing, a torch.',
        'You have no keys.',
        'Wealth: 40 copper farthings',
        '[HP=40/MA=8]:',
        'You add minor healing to your spellbook!'
      ],
      realm ?? undefined
    );

    expect(tracker.current.spellbook).toBeNull();
    expect(carried(tracker)).toEqual(['a torch']);
  });

  /*
   * And with no realm loaded neither half of the lookup can be answered, so
   * the pack is left exactly as it was. The next `i` is what corrects it; a
   * guess at which item went would take a real one off the card, and that is
   * the failure that does not correct itself.
   */
  it('leaves the pack alone when the realm cannot place the spell', () => {
    const tracker = play([...shelf, 'You add minor healing to your spellbook!']);

    expect(tracker.current.spellbook?.at(-1)).toEqual({
      name: 'minor healing',
      short: null,
      level: null,
      cost: null
    });
    expect(carried(tracker)).toEqual([
      'scroll of cause harm',
      'scroll of minor healing',
      'a torch'
    ]);
  });
});

/*
 * The belongings seam: the book survives the session, and a cast→wear-off
 * pair is a measured duration — the only statement of one this client
 * trusts, the realm's `Dur` units being unestablished.
 */
describe('the spellbook and the belongings record', () => {
  function fakeBelongings() {
    const state = {
      spellbook: null as ReadonlyArray<{
        name: string;
        short: string | null;
        level: number | null;
        cost: number | null;
      }> | null,
      durations: {} as Record<string, number>
    };
    return {
      state,
      sink: {
        recallBanks: () => [],
        rememberBanks: () => {},
        recallLoadout: () => [],
        rememberLoadout: () => {},
        recallSpellbook: () => state.spellbook,
        rememberSpellbook: (book: ReadonlyArray<(typeof state.spellbook & object)[number]>) => {
          state.spellbook = book.map((spell) => ({ ...spell }));
        },
        recallSpellDurations: () => state.durations,
        rememberSpellDuration: (spell: string, seconds: number) => {
          state.durations[spell.toLowerCase()] = Math.round(seconds);
        }
      }
    };
  }

  const feedThrough = (tracker: CharacterTracker, lines: string[]): void => {
    const classifier = new Classifier({
      present: () => tracker.current.room.occupants.map((who) => who.name),
      mob: () => undefined
    });
    let seq = 0;
    for (const plain of lines) {
      seq += 1;
      const { block, batch } = classifier.classify({
        seq,
        at: 1_700_000_000_000 + seq * 1000,
        text: plain,
        plain,
        terminator: 'newline'
      });
      tracker.apply(block);
      if (batch) tracker.apply(batch, batch.rows);
    }
  };

  it('writes the book down when a listing commits, and seeds it back at reset', () => {
    const { state, sink } = fakeBelongings();
    const tracker = new CharacterTracker();
    tracker.useBelongings(sink);
    feedThrough(tracker, [
      '[HP=334/KAI=27]:',
      'You have the following powers:',
      'Level Kai  Short Spell Name',
      '  2   1    swan  way of the swan',
      '[HP=334/KAI=27]:'
    ]);
    expect(state.spellbook).toEqual([
      { name: 'way of the swan', short: 'swan', level: 2, cost: 1 }
    ]);

    const next = new CharacterTracker();
    next.useBelongings(sink);
    next.reset();
    expect(next.current.spellbook).toEqual([
      { name: 'way of the swan', short: 'swan', level: 2, cost: 1 }
    ]);
  });

  it("measures its own cast→wear-off pair into the record, and nobody else's", () => {
    const { state, sink } = fakeBelongings();
    const tracker = new CharacterTracker();
    tracker.useBelongings(sink);
    feedThrough(tracker, [
      'Welcome back, Vaelor!',
      '[HP=34]:',
      'You cast bless on yourself!',
      // Two lines at one second apiece — the fake clock steps 1s per line.
      'The effects of bless wear off!'
    ]);
    expect(state.durations['bless']).toBe(1);

    const other = fakeBelongings();
    const blessed = new CharacterTracker();
    blessed.useBelongings(other.sink);
    feedThrough(blessed, [
      'Welcome back, Vaelor!',
      '[HP=34]:',
      'Eagle casts bless on you!',
      'The effects of bless wear off!'
    ]);
    expect(other.state.durations['bless']).toBeUndefined();
  });
});

/**
 * The running totals behind the Combat Stats card, driven through the real
 * classifier from lines the corpus and a live session actually carried.
 *
 * These are the *transcript* the user pasted into todo 10 plus the crit and
 * cast frames from the capture corpus, because what is being asserted is that
 * the frames a real fight produces reach the counters — a hand-made block
 * would test the counter against itself.
 */
describe('what the fighting adds up to', () => {
  it('counts nothing before anything has happened', () => {
    const tally = play(['[HP=57/KAI=3]: ']).current.tally;
    expect(tally.since).toBeNull();
    expect(tally.kills).toBe(0);
    expect(tally.dealt.melee.hits).toBe(0);
  });

  it('separates a critical from an ordinary blow, and keeps both extremes', () => {
    const tally = play([
      '[HP=57/KAI=0]: ',
      '*Combat Engaged*',
      'You punch fat giant rat for 6 damage!',
      'You critically punch fat giant rat for 29 damage!',
      'You punch fat giant rat for 11 damage!'
    ]).current.tally;
    expect(tally.dealt.melee).toEqual({ hits: 2, damage: 17, least: 6, most: 11 });
    expect(tally.dealt.critical).toEqual({ hits: 1, damage: 29, least: 29, most: 29 });
  });

  it('counts a spell apart from a swing', () => {
    const tally = play([
      '[HP=57/MA=30]: ',
      '*Combat Engaged*',
      'You cast earthfist at storm giant king for 44 damage!'
    ]).current.tally;
    expect(tally.dealt.spell.hits).toBe(1);
    expect(tally.dealt.spell.damage).toBe(44);
    expect(tally.dealt.melee.hits).toBe(0);
  });

  /*
   * Somebody else's blow on the same monster is a real fact the fight ledger
   * records, and counting it here would put another player's damage into this
   * character's own average.
   */
  it("counts only this character's own blows", () => {
    const tally = play([
      '[HP=57/KAI=0]: ',
      '*Combat Engaged*',
      'You punch fat giant rat for 6 damage!',
      'Cercio slices fat giant rat for 40 damage!'
    ]).current.tally;
    expect(tally.dealt.melee.hits).toBe(1);
    expect(tally.dealt.melee.damage).toBe(6);
  });

  it('counts what swung at this character, landed or not', () => {
    const tally = play([
      '[HP=57/KAI=0]: ',
      '*Combat Engaged*',
      'The small filthbug swipes at you with its claws!',
      'The angry kobold thief lunges at you for 7 damage!'
    ]).current.tally;
    expect(tally.turned).toBe(1);
    expect(tally.taken.hits).toBe(1);
    expect(tally.taken.damage).toBe(7);
  });

  /*
   * `bs <target>` answers `*Combat Engaged*` and then `You surprise <verb>
   * <target> for N damage!` — captures/001, 008, 009, 011, 013 and 022. That
   * is MegaMUD's `BS:` row, and the tally used to file every one of these
   * under Melee because `blowKind` had never been told the adverb.
   */
  it('separates a backstab from an ordinary blow', () => {
    const tally = play([
      '[HP=104/KAI=9]: ',
      '*Combat Engaged*',
      'You surprise punch Buttah for 37 damage!',
      'You punch Buttah for 11 damage!'
    ]).current.tally;
    expect(tally.dealt.backstab).toEqual({ hits: 1, damage: 37, least: 37, most: 37 });
    expect(tally.dealt.melee.hits).toBe(1);
  });

  /*
   * A swing that did nothing, and one the server said was **dodged**. The
   * second is a fact about this character and the first is not, so they are
   * two figures — 362 lines of the corpus used to land in one.
   */
  it('counts a stated dodge apart from a swing that merely did nothing', () => {
    const tally = play([
      '[HP=57/KAI=0]: ',
      '*Combat Engaged*',
      'The small filthbug swipes at you with its claws!',
      'The small vampire bat swoops towards you, but you dodge!'
    ]).current.tally;
    expect(tally.turned).toBe(1);
    expect(tally.dodged).toBe(1);
  });

  /*
   * MegaMUD's `Sneak:` row. The refusal arrives glued to the attempt on one
   * line, so both halves of the rate are on the wire and neither is inferred.
   */
  it('counts a sneak attempt and the ones the realm refused', () => {
    const tally = play([
      '[HP=107/MA=26]: ',
      'Attempting to sneak...',
      "Attempting to sneak...You don't think you're sneaking."
    ]).current.tally;
    expect(tally.sneakTried).toBe(2);
    expect(tally.sneakFailed).toBe(1);
  });

  /* Coins off the floor, normalised down the ladder the purse is kept on. */
  it('counts coins picked up, in copper', () => {
    const tally = play([
      '[HP=57/KAI=0]: ',
      'You picked up 17 copper farthings',
      'You picked up 3 gold crowns'
    ]).current.tally;
    expect(tally.coins).toBe(317);
  });

  /*
   * The server never says a monster died. Experience gained *while engaged* is
   * the claim the kill count makes, and it says so — experience from anything
   * else arrives out of combat and is experience without being a kill.
   */
  it('counts a kill from experience gained in a fight, and not from experience alone', () => {
    const killed = play([
      '[HP=57/KAI=0]: ',
      '*Combat Engaged*',
      'You critically punch fat giant rat for 29 damage!',
      'The giant rat falls to the ground with a tortured squeak.',
      'You gain 9 experience.'
    ]).current.tally;
    expect(killed.kills).toBe(1);
    expect(killed.experience).toBe(9);

    const handed = play(['[HP=57/KAI=0]: ', 'You gain 500 experience.']).current.tally;
    expect(handed.kills).toBe(0);
    expect(handed.experience).toBe(500);
  });

  /* The server's own word for being in a fight, both ends of it. */
  it('closes the engagement clock when the server says the fight is over', () => {
    const tally = play([
      '[HP=57/KAI=0]: ',
      '*Combat Engaged*',
      'You punch fat giant rat for 6 damage!',
      '*Combat Off*'
    ]).current.tally;
    expect(tally.engagedSince).toBeNull();
    expect(tally.engagedMs).toBeGreaterThanOrEqual(0);
    expect(tally.since).not.toBeNull();
  });

  /*
   * The totals are *this visit's* fighting. An engagement clock left open
   * across a closed socket would count the hours the client sat disconnected
   * as time spent in combat.
   */
  it('forgets everything on leaving the realm', () => {
    const tracker = play([
      '[HP=57/KAI=0]: ',
      '*Combat Engaged*',
      'You punch fat giant rat for 6 damage!'
    ]);
    expect(tracker.current.tally.dealt.melee.hits).toBe(1);
    tracker.leaveRealm();
    expect(tracker.current.tally.dealt.melee.hits).toBe(0);
    expect(tracker.current.tally.since).toBeNull();
    expect(tracker.current.tally.engagedSince).toBeNull();
  });
});

/*
 * The floor a search reveals, which is not the floor a look lists.
 *
 * Reproduced from the live realm, 2026-09-02, in Sarkhee's Jewellery: the room
 * block printed no `You notice` line at all, a `search` turned up four copper
 * farthings and two things, and a bare Enter afterwards reprinted the room
 * still listing nothing. Everything the search found used to be written into a
 * draft that `Obvious exits:` had already completed and discarded — parsed, and
 * read by nobody.
 */
describe('what a search turns up', () => {
  const inTheShop = [
    '[HP=40/MA=8]:',
    "Sarkhee's Jewellery",
    'Also here: Sarkhee.',
    'Obvious exits: east',
    '[HP=40/MA=8]:'
  ];

  it('lands on the room the character is standing in, not in a discarded draft', () => {
    const tracker = play([
      ...inTheShop,
      { send: 'search' },
      'You notice 4 copper farthings, scroll of minor healing, sash of the trainee here.'
    ]);

    const room = tracker.current.room;
    expect(room.name).toBe("Sarkhee's Jewellery");
    expect(room.hidden.map((item) => item.name)).toEqual([
      'scroll of minor healing',
      'sash of the trainee'
    ]);
    expect(room.hiddenCash?.copper).toBe(4);
    // And the open floor is untouched: the search did not put them there.
    expect(room.items).toEqual([]);
    expect(room.cash).toBeNull();
  });

  it("keeps a look's listing and a search's apart on the same floor", () => {
    const tracker = play([
      '[HP=40/MA=8]:',
      'Sewer Tunnel',
      'You notice a rusty key here.',
      'Obvious exits: north',
      '[HP=40/MA=8]:',
      { send: 'search' },
      'You notice 4 copper farthings here.'
    ]);

    expect(tracker.current.room.items.map((item) => item.name)).toEqual(['a rusty key']);
    expect(tracker.current.room.hidden).toEqual([]);
    expect(tracker.current.room.hiddenCash?.copper).toBe(4);
  });

  /* A search is a listing, and a listing replaces what is there. */
  it('is cleared by a search that finds nothing', () => {
    const tracker = play([
      ...inTheShop,
      { send: 'search' },
      'You notice 4 copper farthings here.',
      { send: 'search' },
      'Your search revealed nothing.'
    ]);

    expect(tracker.current.room.hidden).toEqual([]);
    expect(tracker.current.room.hiddenCash).toBeNull();
  });

  /*
   * The directional refusal is an answer about an *exit* and says nothing about
   * the floor — and `Walker` sends one at every `Hidden/Searchable` edge it is
   * refused by, so acting on it would empty the list on every route.
   */
  it('is left alone by a fruitless search in a direction', () => {
    const tracker = play([
      ...inTheShop,
      { send: 'search' },
      'You notice 4 copper farthings here.',
      { send: 'search north' },
      'You notice nothing different to the north'
    ]);

    expect(tracker.current.room.hiddenCash?.copper).toBe(4);
  });

  /*
   * A reprint of the *same* room must not erase it, and this is the one thing
   * that made the feature useless in practice: `automation.idle` sends a bare
   * Enter every 45 seconds by default, `refreshRounds` re-reads the room, and
   * a loop queues an `rm` on every `*Combat Off*`. `items` survives all three
   * because the server reprints `You notice …` on a look — and the whole
   * reason this second floor exists is that it does **not**.
   */
  it('survives a reprint of the same room, which the server sends without it', () => {
    const tracker = play([
      ...inTheShop,
      { send: 'search' },
      'You notice 4 copper farthings, scroll of minor healing here.',
      // The idle keep-alive: a bare Enter, and the room comes back with no
      // `You notice` line at all.
      { send: '' },
      "Sarkhee's Jewellery",
      'Also here: Sarkhee.',
      'Obvious exits: east',
      '[HP=40/MA=8]:'
    ]);

    expect(tracker.current.room.hidden.map((item) => item.name)).toEqual([
      'scroll of minor healing'
    ]);
    expect(tracker.current.room.hiddenCash?.copper).toBe(4);
  });

  it('is left behind when the character walks out', () => {
    const tracker = play([
      ...inTheShop,
      { send: 'search' },
      'You notice 4 copper farthings here.',
      { send: 'e' },
      'Silver Street',
      'Obvious exits: north, south',
      '[HP=40/MA=8]:'
    ]);

    expect(tracker.current.room.name).toBe('Silver Street');
    expect(tracker.current.room.hidden).toEqual([]);
    expect(tracker.current.room.hiddenCash).toBeNull();
  });
});
