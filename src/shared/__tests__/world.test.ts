import { describe, expect, it } from 'vitest';

import { asRoomReference, asRoute } from '../world';
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
