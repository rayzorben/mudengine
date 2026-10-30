import { describe, expect, it } from 'vitest';

import type { WorldGraph } from '../../world/WorldGraph';
import { worldOf } from '../../world/__tests__/realmFile';
import {
  EMPTY_CHARACTER,
  emptyRoom,
  type CharacterState,
  type Room,
  type Stealth
} from '../../../shared/character';
import { wireExit, wireItem } from '../../../shared/entities';
import { NO_PLAYERS } from '../../../shared/players';
import { Expectations, type CommandContext } from '../expectations';
import { playerArrives, playerFoundHiding, RoomTracker, type RoomClaims } from '../room';

/*
 * The order a room block spends what it is handed is a decision (todo 700:
 * *order is a decision*), and the tracker's tests cannot see it: they drive
 * whole blocks and assert the state that comes out, and reorderings inside
 * `room.ts` passed every one of them (todo 720's review). So these hand
 * `RoomTracker` a queue that writes down each reach into it, with the stealth
 * receipt and the trail beside it, and pin the sequence the settled decisions
 * rely on (`mudengine-wire` › *A look is not a step*, *A late answer is not a
 * re-look*, *A search's answer wears a look's sentence*).
 */

const SHORE = { m: 1, r: 1, n: 'Shore', x: { e: { m: 1, r: 2 } } };
const BEACH = { m: 1, r: 2, n: 'East Beach', pt: 1, x: { w: { m: 1, r: 1 } } };
const CAVERN = { m: 2, r: 1, n: 'Far Cavern', x: { w: { m: 2, r: 3 } } };
const HOLLOW = { m: 2, r: 3, n: 'Hollow', x: {} };
const PIT = { m: 2, r: 2, n: 'Black Pit', li: -200, x: {} };

/** A five-room realm: a lit step (Shore → East Beach), a portal's landing, a dark pit. */
const world = (): WorldGraph => worldOf([SHORE, BEACH, CAVERN, HOLLOW, PIT]);

const IN_GAME: CommandContext = {
  inGame: true,
  atMenu: false,
  typedExit: () => null,
  occupantNamed: () => null
};

/** A room tracker whose every reach into what it was handed is written down, in order. */
function rig(
  receipt: Stealth = 'sneaking',
  graph: WorldGraph = world()
): {
  log: string[];
  queue: Expectations;
  room: RoomTracker;
} {
  const log: string[] = [];
  const queue = new Expectations();
  const claims: RoomClaims = {
    head: () => {
      log.push('head');
      return queue.head();
    },
    shift: () => {
      log.push('shift');
      return queue.shift();
    },
    takeUnmodelled: (answerable) => {
      log.push(`unmodelled(${answerable})`);
      return queue.takeUnmodelled(answerable);
    },
    takeTeleport: () => {
      log.push('teleport');
      return queue.takeTeleport();
    },
    clearLooks: () => {
      log.push('clearLooks');
      queue.clearLooks();
    },
    get promised() {
      log.push('promised');
      return queue.promised;
    },
    get portalOwed() {
      log.push('portalOwed');
      return queue.portalOwed;
    },
    answerRereadBehind: () => {
      log.push('rereadBehind');
      queue.answerRereadBehind();
    }
  };
  const room = new RoomTracker({
    world: graph,
    claims,
    family: () => null,
    registry: () => NO_PLAYERS,
    itemEntity: (name, observed) => wireItem(name, observed),
    stealthAfterMove: () => {
      log.push('stealth');
      return receipt;
    },
    rememberTheWayBack: () => {
      log.push('wayBack');
    },
    onTargetGone: () => {
      log.push('targetGone');
    },
    onDiscovery: () => {
      log.push('discovery');
    }
  });
  return { log, queue, room };
}

/** Standing in a placed room, seen. */
function at(map: number, number: number, name: string, over: Partial<Room> = {}): CharacterState {
  const s = structuredClone(EMPTY_CHARACTER);
  return {
    ...s,
    stealth: 'seen',
    room: { ...s.room, map, number, name, confidence: 1, ambiguous: 1, ...over }
  };
}

describe('the order a room block spends what it is handed', () => {
  it('a peek takes its claim and the unmodelled slot, and never a promised teleport', () => {
    const { log, queue, room } = rig();
    queue.hintTeleport('dive pool', 2, 1);
    queue.observeCommand('l e', IN_GAME);
    queue.observeCommand('pull lever', IN_GAME);
    room.begin('East Beach');
    const out = room.exits(at(1, 1, 'Shore'), 'west', 5);
    expect(out.peeked?.room.name).toBe('East Beach');
    expect(log).toEqual(['head', 'shift', 'unmodelled(false)']);
    // And its draft went with it: the next block, nameless, inherits nothing.
    const next = room.exits({ ...at(1, 1, 'Shore'), room: emptyRoom() }, undefined, 6);
    expect(next.room.name).toBeNull();
  });

  it('a teleport arrival is counted and spends its receipt before the promise', () => {
    const { log, queue, room } = rig('sneaking');
    queue.hintTeleport('dive pool', 2, 1);
    queue.observeCommand('dive pool', IN_GAME);
    room.begin('Far Cavern');
    const s = at(1, 1, 'Shore');
    const out = room.exits(s, 'west', 5);
    expect([out.room.map, out.room.number]).toEqual([2, 1]);
    expect(out.room.arrival).toBe(s.room.arrival + 1);
    // The early return for a teleport carries the receipt computed above it.
    expect(out.stealth).toBe('sneaking');
    // The claim it answered was the portal's, so whether one is owed is not asked.
    expect(log).toEqual(['head', 'shift', 'unmodelled(false)', 'stealth', 'teleport']);
  });

  /*
   * A portal retried before it landed (todo 763): the landing answers the first
   * claim and spends the promise, though the retry's claim is still owed.
   */
  it('a landing that answers a portal spends the promise while a retry is owed', () => {
    const { log, queue, room } = rig();
    queue.hintTeleport('dive pool', 2, 1);
    queue.observeCommand('dive pool', IN_GAME);
    queue.hintTeleport('dive pool', 2, 1);
    queue.observeCommand('dive pool', IN_GAME);
    room.begin('Far Cavern');
    const out = room.exits(at(1, 1, 'Shore'), 'west', 5);
    expect(out.room.resolvedBy).toBe('coordinates');
    expect(log).toEqual(['head', 'shift', 'unmodelled(false)', 'stealth', 'teleport']);
    expect(queue.portalOwed).toBe(true);
  });

  it('a re-look keeps what a search found, and spends a promise before returning', () => {
    const { log, room } = rig();
    const found = [wireItem('silver key', {})];
    const s = at(1, 1, 'Shore', { hidden: found });
    room.begin('Shore');
    const out = room.exits(s, 'east', 5);
    // Carried above every return: the re-look is one of them.
    expect(out.room.hidden).toBe(found);
    expect(out.room.number).toBe(1);
    expect(log).toEqual(['head', 'unmodelled(true)', 'portalOwed', 'teleport']);
  });

  it('a reprint of the room a portal is leaving answers the Enter behind it, never the promise', () => {
    const { log, queue, room } = rig();
    queue.hintTeleport('dive pool', 2, 1);
    queue.observeCommand('dive pool', IN_GAME);
    queue.noteReread(true);
    room.begin('Shore');
    const out = room.exits(at(1, 1, 'Shore'), 'east', 5);
    expect([out.room.map, out.room.number]).toEqual([1, 1]);
    expect(log).toEqual(['head', 'promised', 'rereadBehind', 'unmodelled(true)', 'portalOwed']);
    expect(queue.count).toBe(1);
    expect(queue.promised).toEqual({ map: 2, number: 1 });
  });

  it('a nameless reprint keeps the place and drops its draft', () => {
    const { room } = rig();
    const s = at(1, 1, 'Shore');
    room.items('rope');
    const first = room.exits(s, undefined, 5);
    expect(first.room.number).toBe(1);
    const again = room.exits(s, undefined, 6);
    expect(again.room.items).toEqual([]);
  });

  it('a step spends the receipt, then any promise, and records the way back last', () => {
    const { log, queue, room } = rig();
    queue.pushMove('e', 'e');
    room.begin('East Beach');
    const out = room.exits(at(1, 1, 'Shore'), 'west', 5);
    expect([out.room.map, out.room.number]).toEqual([1, 2]);
    expect(log).toEqual([
      'head',
      'shift',
      'unmodelled(false)',
      'stealth',
      'portalOwed',
      'teleport',
      'wayBack'
    ]);
  });

  it('a dark look spends only its own claim', () => {
    const { log, queue, room } = rig();
    queue.hintTeleport('dive pool', 2, 1);
    queue.noteReread(true);
    expect(room.arrivedUnseen(at(2, 2, 'Black Pit'), 'dark')).toBeNull();
    expect(log).toEqual(['shift']);
  });

  it('a dark step: the claim, the promise, the looks, then the way back and the receipt', () => {
    const { log, queue, room } = rig();
    queue.pushMove('e', 'e');
    room.arrivedUnseen(at(1, 1, 'Shore'), 'dark');
    expect(log).toEqual([
      'shift',
      'teleport',
      'clearLooks',
      'unmodelled(false)',
      'wayBack',
      'stealth'
    ]);
  });
});

describe('what the realm says about the room it placed (todo 87)', () => {
  it('marks a room the realm data protects safe, and leaves the next room unknown', () => {
    const { queue, room } = rig();
    queue.pushMove('e', 'e');
    room.begin('East Beach');
    const beach = room.exits(at(1, 1, 'Shore'), 'west', 5);
    expect(beach.room.safe).toBe(true);
    queue.pushMove('w', 'w');
    room.begin('Shore');
    const shore = room.exits(beach, 'east', 6);
    expect(shore.room.number).toBe(1);
    expect(shore.room.safe).toBeUndefined();
  });
});

describe('the spell the realm says the placed room casts (todo 72)', () => {
  it('names what stops it on the room, and leaves the next room without one', () => {
    const graph = worldOf([{ ...SHORE }, { ...BEACH, sp: 683 }], {
      items: [{ id: 1180, n: 'waterskin' }],
      spells: [
        { id: 683, n: 'desert spell', hz: { d: 13, r: { d: [[null, null, [1180], [711]]] } } },
        { id: 711, n: 'quench' }
      ]
    });
    const { queue, room } = rig('sneaking', graph);
    queue.pushMove('e', 'e');
    room.begin('East Beach');
    const beach = room.exits(at(1, 1, 'Shore'), 'west', 5);
    expect(beach.room.spell?.name).toBe('desert spell');
    expect(beach.room.spellStoppedBy).toEqual({
      items: [{ id: 1180, name: 'waterskin' }],
      spells: [{ id: 711, name: 'quench' }]
    });
    expect(beach.room.passage).toBeNull();
    queue.pushMove('w', 'w');
    room.begin('Shore');
    const shore = room.exits(beach, 'east', 6);
    expect(shore.room.number).toBe(1);
    expect(shore.room.spell).toBeNull();
    expect(shore.room.spellStoppedBy).toBeUndefined();
  });
});

describe('a search finding a hidden player (todo 87)', () => {
  it('adds the player to the room, hidden, where no listing named them', () => {
    const out = playerFoundHiding(at(1, 1, 'Shore'), 'Nusse');
    expect(out?.room.occupants).toEqual([
      expect.objectContaining({ name: 'Nusse', kind: 'player', hidden: true })
    ]);
    // Found again with nothing new: no change.
    expect(playerFoundHiding(out!, 'Nusse')).toBeNull();
  });

  it('marks a listed occupant a hidden player, where an arrival changes nothing', () => {
    const listed = playerArrives(at(1, 1, 'Shore'), 'Nusse')!;
    expect(playerArrives(listed, 'Nusse')).toBeNull();
    const out = playerFoundHiding(listed, 'Nusse');
    expect(out?.room.occupants).toEqual([
      expect.objectContaining({ name: 'Nusse', kind: 'player', hidden: true })
    ]);
  });
});

/*
 * Todo 151: a found way is written from the room the client believes it left,
 * so a room whose printed exits that room cannot have is no room to write
 * one from. The typed direction is left out of the test, so an exit a
 * derivative added is still learned.
 */
describe('the room a found way is written from', () => {
  // Hall's only way is south; Yard is somewhere no exit of Hall reaches.
  const HALL = { m: 1, r: 1, n: 'Hall', x: { s: { m: 1, r: 3 } } };
  const COURT = { m: 1, r: 3, n: 'Court', x: { n: { m: 1, r: 1 } } };
  const YARD = { m: 1, r: 2, n: 'Yard', x: { w: { m: 1, r: 3 } } };
  const step = (printed: readonly string[]): string[] => {
    const { log, queue, room } = rig('seen', worldOf([HALL, COURT, YARD]));
    queue.observeCommand('e', IN_GAME);
    room.begin('Yard');
    room.exits(at(1, 1, 'Hall', { exits: printed.map((one) => wireExit(one)) }), 'west', 5);
    return log.filter((entry) => entry === 'discovery');
  };

  it('writes one from a room whose printed exits fit it (control)', () => {
    expect(step(['s'])).toEqual(['discovery']);
    // An `e` the room printed and the realm lacks is the derivative's new exit.
    expect(step(['s', 'e'])).toEqual(['discovery']);
  });

  it('writes none from a room that printed an exit it lacks', () => {
    expect(step(['n', 's', 'e', 'w'])).toEqual([]);
  });
});
