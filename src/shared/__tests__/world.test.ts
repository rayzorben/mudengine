import { describe, expect, it } from 'vitest';

import {
  asRoomReference,
  asRoute,
  describeBlock,
  hazardFor,
  type SpellHazard,
  newDemands,
  openableHere,
  parseLair,
  lairsAlong,
  trapOn,
  trapsAlong,
  type Route,
  type RouteStep
} from '../world';
import { asConnectionTarget } from '../types';

/** A route the pathfinder would really produce. */
const good = {
  blocked: false,
  cost: 3,
  steps: [
    { from: '1/1', to: '1/2', direction: 'n', command: 'n', name: 'Somewhere', requirement: null }
  ]
};

describe('asRoute', () => {
  it('accepts a route the pathfinder produced', () => {
    expect(asRoute(good)).toEqual(good);
  });

  it('accepts a blocked route with no steps', () => {
    expect(asRoute({ blocked: true, cost: 0, steps: [], reason: 'nope' })).not.toBeNull();
  });

  /*
   * This is the payload that turns into commands on a socket, so everything
   * below is a thing a window could send that must not reach the walker. A
   * malformed route otherwise fails frames later, inside automation, where the
   * stack says nothing about where it came from.
   */
  const rejected: Array<[string, unknown]> = [
    ['null', null],
    ['a string', 'n'],
    ['a number', 7],
    ['an array', []],
    ['no steps at all', { blocked: false, cost: 1 }],
    ['steps that are not a list', { blocked: false, cost: 1, steps: 'n' }],
    ['a step that is not an object', { blocked: false, cost: 1, steps: ['n'] }],
    [
      'a step with no command',
      { blocked: false, cost: 1, steps: [{ from: '1/1', to: '1/2', name: 'x' }] }
    ],
    [
      'a step with an empty command',
      { blocked: false, cost: 1, steps: [{ from: '1/1', to: '1/2', name: 'x', command: '' }] }
    ],
    [
      'a step whose rooms are not ids',
      { blocked: false, cost: 1, steps: [{ from: 1, to: 2, name: 'x', command: 'n' }] }
    ],
    ['a cost that is not finite', { blocked: false, cost: Number.NaN, steps: [] }],
    ['a blocked flag that is not a boolean', { blocked: 'yes', cost: 0, steps: [] }]
  ];

  for (const [what, payload] of rejected) {
    it(`refuses ${what}`, () => {
      expect(asRoute(payload)).toBeNull();
    });
  }
});

describe('asConnectionTarget', () => {
  const good = { host: 'gmud-tgs', port: 2427, encoding: 'cp437' };

  it('accepts a target the options file would produce', () => {
    expect(asConnectionTarget(good)).toEqual(good);
  });

  it('trims a host rather than dialling one with whitespace in it', () => {
    expect(asConnectionTarget({ ...good, host: '  localhost  ' })?.host).toBe('localhost');
  });

  /*
   * A port is the part worth being strict about: it is handed to the socket
   * layer, where anything outside 1-65535 throws rather than refusing, and a
   * throw inside an IPC handler is a rejected promise nobody is holding.
   */
  const rejected: Array<[string, unknown]> = [
    ['null', null],
    ['a string', 'gmud-tgs:2427'],
    ['no host', { port: 2427, encoding: 'cp437' }],
    ['an empty host', { ...good, host: '   ' }],
    ['a port of zero', { ...good, port: 0 }],
    ['a port past the end of the range', { ...good, port: 65_536 }],
    ['a negative port', { ...good, port: -1 }],
    ['a fractional port', { ...good, port: 2427.5 }],
    ['a port that is a string', { ...good, port: '2427' }],
    ['an encoding nothing can decode', { ...good, encoding: 'ebcdic' }]
  ];

  for (const [what, payload] of rejected) {
    it(`refuses ${what}`, () => {
      expect(asConnectionTarget(payload)).toBeNull();
    });
  }
});

describe('asRoomReference', () => {
  /*
   * The three separators a person actually types, having read `1/2150` off the
   * Room card's badge. Whitespace around the punctuation is a typing habit, not
   * a different intent.
   */
  for (const typed of ['1,2150', '1 2150', '1/2150', '  1 , 2150 ', '1  2150', '1 / 2150']) {
    it(`reads ${JSON.stringify(typed)} as a room`, () => {
      expect(asRoomReference(typed)).toEqual({ map: 1, room: 2150 });
    });
  }

  /*
   * Everything else stays a *name* search, and that is the load-bearing half:
   * the alternative to a reference is a substring query over 55,806 rooms, so
   * anything ambiguous must fall through rather than send somebody somewhere.
   */
  const notAReference: Array<[string, string]> = [
    ['2150', 'a bare number names no map, and a room name can be a number'],
    ['', 'nothing typed yet'],
    ['Newhaven', 'an ordinary name'],
    ['Level 3', 'a name that ends in a number'],
    ['1,,2150', 'two separators is a typing mistake, not a wider grammar'],
    ['1//2150', 'the same, with the other punctuation'],
    ['1/2150/3', 'three numbers is not a room'],
    ['-1/2150', 'no map is negative'],
    ['1.5/2150', 'no map is fractional'],
    ['1/2150x', 'trailing rubbish'],
    ['x1/2150', 'leading rubbish'],
    ['1-2150', 'a hyphen is not one of the three separators'],
    ['1/', 'half a reference'],
    ['/2150', 'the other half']
  ];
  for (const [typed, why] of notAReference) {
    it(`leaves ${JSON.stringify(typed)} to the name search — ${why}`, () => {
      expect(asRoomReference(typed)).toBeNull();
    });
  }

  it('refuses a number too large to be held exactly', () => {
    // Past 2^53 the value that comes back is not the one that was typed, and a
    // map id that has already lost precision is not the map anybody meant.
    expect(asRoomReference('1/90071992547409919')).toBeNull();
  });

  it('accepts room 0, which is a room and not an absence', () => {
    expect(asRoomReference('0/0')).toEqual({ map: 0, room: 0 });
  });
});

describe('lairsAlong', () => {
  const step = (danger?: number, deadly?: boolean): RouteStep => ({
    from: '1/1',
    to: '1/2',
    direction: 'n',
    command: 'n',
    name: 'Somewhere',
    requirement: null,
    dark: false,
    ...(danger === undefined ? {} : { danger }),
    ...(deadly === undefined ? {} : { deadly })
  });

  it('counts nothing on a route through no lair', () => {
    expect(lairsAlong([step(), step()])).toEqual({ count: 0, worst: null, deadly: null });
  });

  it('counts every lair and keeps the heaviest share', () => {
    expect(lairsAlong([step(0.1), step(), step(0.45), step(0.2)])).toEqual({
      count: 3,
      worst: 0.45,
      deadly: null
    });
  });

  /*
   * **Which** room, not merely that there is one. On a hundred-and-four-step
   * route the reader was told one was expected to kill them and left to scroll
   * for the chip; the room is named at the head and is the control that opens
   * what is in it.
   */
  it('names the room the router walked into that it expects to kill you', () => {
    expect(lairsAlong([step(0.1), step(1.4, true)])).toEqual({
      count: 2,
      worst: 1.4,
      deadly: { room: '1/2', name: 'Somewhere' }
    });
  });

  /* A room whose own spell takes the bar is deadly with no lair to count. */
  it('names a room deadly by its own spell, with no lair counted', () => {
    const river: RouteStep = { ...step(), hazard: 1.5, deadly: true, name: 'Magma' };
    expect(lairsAlong([step(), river])).toEqual({
      count: 0,
      worst: null,
      deadly: { room: '1/2', name: 'Magma' }
    });
  });

  /* The first, in walking order: a later one is a room nobody reaches. */
  it('names the first of them, which is the one that stops the walk', () => {
    const first: RouteStep = { ...step(1.2, true), to: '1/7', name: 'The Pit' };
    const second: RouteStep = { ...step(1.9, true), to: '1/9', name: 'Deeper' };
    expect(lairsAlong([first, second]).deadly).toEqual({ room: '1/7', name: 'The Pit' });
  });
});

describe('trapsAlong', () => {
  const step = (requirement: RouteStep['requirement']): RouteStep => ({
    from: '1/1',
    to: '1/2',
    direction: 'n',
    command: 'n',
    name: 'Somewhere',
    requirement,
    dark: false
  });

  it('counts nothing on a route with no traps', () => {
    const steps = [step(null), step({ kind: 'door', raw: 'Door' })];
    expect(trapsAlong(steps)).toEqual({ count: 0, worst: null });
  });

  it('counts every trapped step and keeps the heaviest stated damage', () => {
    const steps = [
      step({ kind: 'trap', raw: 'Trap, 40 damage', damage: 40 }),
      step(null),
      step({ kind: 'trap', raw: 'Trap, 400 damage', damage: 400 }),
      step({ kind: 'trap', raw: 'Trap, 150 damage', damage: 150 })
    ];
    expect(trapsAlong(steps)).toEqual({ count: 3, worst: 400 });
  });

  it('is null, not zero, when no trap states a damage', () => {
    // A derivative may write a bare `Trap`; *up to 0 damage* would be a
    // reassuring number the data never gave.
    expect(trapsAlong([step({ kind: 'trap', raw: 'Trap' })])).toEqual({ count: 1, worst: null });
  });

  /* The one rule for what a trap is, shared with the walker's rest before one. */
  it('names the trap on a step, and its damage where the realm states one', () => {
    expect(trapOn(step(null))).toBeNull();
    expect(trapOn(step({ kind: 'door', raw: 'Door' }))).toBeNull();
    expect(trapOn(step({ kind: 'trap', raw: 'Trap, 36 damage', damage: 36 }))).toEqual({
      damage: 36
    });
    expect(trapOn(step({ kind: 'trap', raw: 'Trap' }))).toEqual({ damage: null });
    expect(trapOn(step({ kind: 'spell', raw: 'Spell Trap: 12', damage: 9 }))).toEqual({
      damage: 9
    });
  });

  /*
   * A `Spell Trap:` exit is a trap by the server's own reckoning — it refuses
   * nobody and fires a spell at whoever walks it — and it carries its damage in
   * the same field, read off the realm's spell table. Leaving it out said *no
   * traps on this route* about a route through 21 exits that shoot poison
   * darts.
   */
  it('counts a spell trap, whose hurt comes from the spell table', () => {
    const steps = [
      step({ kind: 'trap', raw: 'Trap, 400 damage', damage: 400 }),
      step({ kind: 'spell', raw: 'Spell Trap: 905', spellId: 905, damage: 16 }),
      step({ kind: 'spell', raw: 'Spell Trap: 851', spellId: 851 })
    ];
    expect(trapsAlong(steps)).toEqual({ count: 3, worst: 400 });
  });

  it('ignores a stated damage on a step that is not a trap', () => {
    const steps = [step({ kind: 'door', raw: 'Door', damage: 99 } as never)];
    expect(trapsAlong(steps)).toEqual({ count: 0, worst: null });
  });
});

describe('newDemands', () => {
  const step = (requirement: RouteStep['requirement'], label?: string): RouteStep => ({
    from: '1/1',
    to: '1/2',
    direction: 'n',
    command: 'n',
    name: 'Somewhere',
    requirement,
    dark: false,
    ...(label === undefined || requirement === null
      ? {}
      : { obstacle: { kind: requirement.kind, label, detail: label, raw: requirement.raw } })
  });
  const route = (steps: RouteStep[], rest: Partial<Route> = {}): Route => ({
    steps,
    cost: steps.length,
    blocked: false,
    ...rest
  });

  /* A plan redrawn two corridors along is a different list of rooms and the
     same walk. Different steps are not the question. */
  it('says nothing about a longer way that asks for no more than the old one', () => {
    const before = route([step(null)]);
    const after = route([step(null), step(null), step(null)]);
    expect(newDemands(before, after)).toEqual([]);
  });

  it('names a key the new way wants and the old one did not', () => {
    const before = route([step(null)]);
    const after = route([step({ kind: 'key', raw: 'Key: 1124' }, 'key 1124')]);
    expect(newDemands(before, after)).toEqual(['key 1124']);
  });

  /* Keyed on the realm's instruction, not on the room it is written in: two
     locked doors wanting one key are one errand, and a plan that goes through
     the same door from a different room asks nothing new. */
  it('says nothing about the same instruction met in another room', () => {
    const gate = { kind: 'toll', raw: 'Toll: 5' } as const;
    const before = route([step(gate, 'toll 5')]);
    const after = route([{ ...step(gate, 'toll 5'), from: '1/9', to: '1/8' }]);
    expect(newDemands(before, after)).toEqual([]);
  });

  /* A way that asks for *less* is the same journey made easier, and stopping
     to ask about it would be the client arguing with a piece of luck. */
  it('says nothing when the new way drops a requirement', () => {
    const before = route([step({ kind: 'level', raw: 'Level: 20' }, 'level 20')]);
    expect(newDemands(before, route([step(null)]))).toEqual([]);
  });

  /* The walls this way crosses, and the items a room's own spell wants — the
     two halves of "requirement" that are not written on a step. */
  it('names a wall and an item the new way needs', () => {
    const before = route([step(null)]);
    const after = route([step(null)], {
      walls: [{ kind: 'unreachable' }],
      hazards: [
        {
          id: 754,
          spell: 'river damage',
          rooms: 4,
          share: 0.1,
          unread: false,
          summons: false,
          relocates: false,
          needs: [{ id: 191, name: 'log raft' }],
          needsSpell: []
        }
      ]
    });
    expect(newDemands(before, after)).toEqual([describeBlock({ kind: 'unreachable' }), 'log raft']);
  });
});

describe('parseLair', () => {
  /* GreaterMUD's own spelling, and what docs/greatermud/player-and-world.md records. */
  it('reads the slot count and the monster numbers', () => {
    expect(parseLair('(Max 2): 1141,2175,2176,')).toEqual({
      max: 2,
      ids: [1141, 2175, 2176]
    });
  });

  /*
   * Paradigm's export appends its own spawn parameters, and every one of the
   * shipped realm's 14,068 lairs carries them. Read as monster numbers they put
   * four creatures the realm never placed onto the Room card's lair face.
   */
  it('refuses the exporter’s bracketed parameters as monsters', () => {
    expect(parseLair('(Max 2): 781,190,[6-30-31-2]')).toEqual({
      max: 2,
      ids: [781, 190]
    });
    // The Temple Healer's own lair: one healer, not a healer plus a lashworm,
    // two ghouls and a giant rat.
    expect(parseLair('(Max 1): 47,[2-16-16-1]')).toEqual({ max: 1, ids: [47] });
  });

  /*
   * The `(Max n)` clause is removed whole rather than the first number being
   * dropped. A descriptor stating no maximum would otherwise lose a monster.
   */
  it('keeps every number when no maximum is stated', () => {
    expect(parseLair('12,44,')).toEqual({ max: null, ids: [12, 44] });
  });

  it('de-duplicates, and names nothing for a blank descriptor', () => {
    expect(parseLair('(Max 2): 5,5,7,')).toEqual({ max: 2, ids: [5, 7] });
    // GreaterMUD writes a single space into every ordinary room's column.
    expect(parseLair(' ')).toEqual({ max: null, ids: [] });
    expect(parseLair('')).toEqual({ max: null, ids: [] });
  });

  /* Zero is the realm's own way of saying nothing, not monster #0. */
  it('drops a zero', () => {
    expect(parseLair('(Max 1): 0,')).toEqual({ max: 1, ids: [] });
  });
});

/*
 * *Can this be opened where it stands* — one reading, because the price, the
 * chip and the walker's rung each ask it and three copies agree only until one
 * is edited.
 */
describe('openableHere', () => {
  const gated = (actions?: Array<{ say: string[]; at?: { map: number; room: number } }>) => ({
    kind: 'hidden' as const,
    raw: 'Hidden/Needs 1 Actions, any order',
    searchable: false,
    ...(actions === undefined ? {} : { actions })
  });

  it('is true when every lever is in the room the exit leaves', () => {
    expect(openableHere(gated([{ say: ['pull lever'] }]))).toBe(true);
    expect(openableHere(gated([{ say: ['twist knot'] }, { say: ['push knot'] }]))).toBe(true);
  });

  it('is false when any lever is somewhere else', () => {
    expect(openableHere(gated([{ say: ['pull lever'], at: { map: 1, room: 1339 } }]))).toBe(false);
    expect(openableHere(gated([{ say: ['a'] }, { say: ['b'], at: { map: 1, room: 2 } }]))).toBe(
      false
    );
  });

  /* The realm naming no lever, and a realm converted before they were read,
     are the same answer as far as anything acting on this goes. */
  it('is false when the realm names no lever at all', () => {
    expect(openableHere(gated())).toBe(false);
    expect(openableHere(gated([]))).toBe(false);
  });

  it('is false for anything that is not a hidden exit', () => {
    expect(openableHere(null)).toBe(false);
    expect(openableHere({ kind: 'door', raw: 'Door' })).toBe(false);
    expect(openableHere({ kind: 'hidden', raw: 'Hidden/Searchable', searchable: true })).toBe(
      false
    );
  });
});

/*
 * A gate on level says *which* character, and the router is planning for one
 * (todo 01). Paradigm's desert spell: a one-in-a-hundred sandstorm gated at
 * `maxlevel 19`, on 979 rooms a level 21 character walks through.
 */
describe('a hazard as it applies to one character', () => {
  const desert: SpellHazard = {
    relocates: true,
    summons: true,
    avoidedBySpell: [711],
    levels: { relocates: { max: 19 } }
  };

  it('drops an effect the realm has already excluded this character from', () => {
    expect(hazardFor(desert, 21).relocates).toBe(false);
    // And keeps everything the band says nothing about.
    expect(hazardFor(desert, 21).summons).toBe(true);
    expect(hazardFor(desert, 21).avoidedBySpell).toEqual([711]);
  });

  it('keeps it for a character inside the band', () => {
    expect(hazardFor(desert, 19).relocates).toBe(true);
    expect(hazardFor(desert, 1).relocates).toBe(true);
  });

  /*
   * Unknown is never the reassuring answer, and here the reassuring answer is
   * *it cannot happen to you*: a character the client cannot place is priced
   * for the whole chain, exactly as it was before any of this.
   */
  it('keeps the whole hazard for an unstated level', () => {
    expect(hazardFor(desert, null)).toBe(desert);
    expect(hazardFor(desert, undefined)).toBe(desert);
  });

  it('is the same object where nothing is gated, so the ordinary room is free', () => {
    const plain: SpellHazard = { damage: 15, avoidedBy: [690] };
    expect(hazardFor(plain, 21)).toBe(plain);
  });

  it('reads a minimum as well as a maximum', () => {
    const summonsHigh: SpellHazard = { summons: true, levels: { summons: { min: 50 } } };
    expect(hazardFor(summonsHigh, 21).summons).toBe(false);
    expect(hazardFor(summonsHigh, 50).summons).toBe(true);
  });
});
