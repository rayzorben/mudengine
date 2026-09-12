import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RestAway, type RestAwayPlanner } from '../RestAway';
import { CommandQueue } from '../CommandQueue';
import { DEFAULT_CONFIG, type AutomationConfig, type HealthConfig } from '../../../shared/config';
import { EMPTY_CHARACTER, type CharacterState, type RoomOccupant } from '../../../shared/character';
import { classifyOccupant } from '../../../shared/mobs';
import type { SafetyDecision } from '../../../shared/automation';
import type { Direction } from '../../../shared/world';

const automation: AutomationConfig = {
  ...DEFAULT_CONFIG.automation,
  pacing: { window: 8, minGapMs: 0, ackTimeoutMs: 1000 }
};

const health = (over: Partial<HealthConfig> = {}): HealthConfig => ({
  ...DEFAULT_CONFIG.automation.health,
  restBelow: 0.35,
  restTo: 0.7,
  restNextDoor: true,
  ...over
});

const mob = (name: string): RoomOccupant =>
  classifyOccupant(name, {
    players: new Set<string>(),
    mob: () => ({ disposition: 'hostile', uncertain: false, costly: 'never' })
  });

/** Hurt, in the wererat lair, the fight over and the room empty. */
function hurtInTheLair(over: Partial<CharacterState> = {}): CharacterState {
  const base = structuredClone(EMPTY_CHARACTER);
  return {
    ...base,
    phase: 'in-game',
    room: { ...base.room, map: 8, number: 915, name: 'Ancient Stronghold, Stable', occupants: [] },
    vitals: { ...base.vitals, hp: 60, hpMax: 289 },
    ...over
  };
}

/** The neighbour, seen through a peek at `at`. */
function peeked(
  state: CharacterState,
  direction: Direction,
  occupants: RoomOccupant[],
  at: number
): CharacterState {
  const base = structuredClone(EMPTY_CHARACTER);
  return {
    ...state,
    peeked: {
      direction,
      room: { ...base.room, map: 8, number: 914, name: 'Ancient Stronghold, Yard', occupants },
      at
    }
  };
}

let sent: string[];
let notices: string[];
let decisions: SafetyDecision[];
let queue: CommandQueue;
let here: string | null;
let looping: boolean;

const planner = (over: Partial<RestAwayPlanner> = {}): RestAwayPlanner => ({
  here: () => here,
  lairClock: (room) => (room === '8/915' ? 30 : null),
  neighbours: (room) =>
    room === '8/915'
      ? [
          { direction: 'n', to: '8/914', name: 'Ancient Stronghold, Yard' },
          { direction: 'e', to: '8/916', name: 'Ancient Stronghold, Hall' }
        ]
      : [],
  moveInFlight: () => false,
  walking: () => false,
  looping: () => looping,
  busy: () => false,
  ...over
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
  sent = [];
  notices = [];
  decisions = [];
  here = '8/915';
  looping = false;
  queue = new CommandQueue(automation, { send: (command) => sent.push(command) });
});

afterEach(() => {
  queue.dispose();
  vi.useRealTimers();
});

const make = (config = health(), over: Partial<RestAwayPlanner> = {}, enabled = true): RestAway =>
  new RestAway(config, enabled, queue, planner(over), {
    notice: (m) => notices.push(m),
    decided: (d) => decisions.push(d)
  });
const drain = (): void => void vi.advanceTimersByTime(500);

describe('resting in a lair with a short clock', () => {
  it('refuses the rest there, out loud with the clock, and looks next door first', () => {
    const auto = make();
    expect(auto.consider(hurtInTheLair(), true)).toBe('took-over');
    drain();
    expect(sent).toEqual(['l n']);
    expect(notices[0]).toMatch(/makes monsters every 30s/);
    expect(notices[0]).toMatch(/Ancient Stronghold, Yard/);
  });

  it('steps into the peeked room only when nobody is standing in it, and rests there', () => {
    const auto = make();
    auto.consider(hurtInTheLair(), true);
    drain();
    auto.consider(peeked(hurtInTheLair(), 'n', [], Date.now()), true);
    drain();
    expect(sent).toEqual(['l n', 'n']);
    // Landed: the rest is now `Recovery`'s, in a room with no clock.
    here = '8/914';
    expect(auto.consider(peeked(hurtInTheLair(), 'n', [], Date.now()), true)).toBe('not-mine');
    expect(decisions.at(-1)).toMatchObject({ action: 'rest away', acted: true });
  });

  /* The reviewer's case: somebody dragged the room full and hung up. */
  it('does not step into a room something is standing in, and tries the next neighbour', () => {
    const auto = make();
    auto.consider(hurtInTheLair(), true);
    drain();
    auto.consider(peeked(hurtInTheLair(), 'n', [mob('wererat'), mob('wererat')], Date.now()), true);
    expect(notices.at(-1)).toMatch(/Not resting in Ancient Stronghold, Yard: wererat, wererat/);
    auto.consider(hurtInTheLair(), true);
    drain();
    expect(sent).toEqual(['l n', 'l e']);
  });

  it('rests here after all, once, when no neighbour is safe', () => {
    const auto = make(health(), { neighbours: () => [] });
    expect(auto.consider(hurtInTheLair(), true)).toBe('rest-here');
    expect(auto.consider(hurtInTheLair(), true)).toBe('rest-here');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/Resting here after all/);
    expect(decisions[0]).toMatchObject({ action: 'rest away', acted: false });
    expect(sent).toEqual([]);
  });

  it('treats a look nothing answered as not proven safe', () => {
    const auto = make();
    auto.consider(hurtInTheLair(), true);
    drain();
    vi.advanceTimersByTime(5000);
    expect(auto.consider(hurtInTheLair(), true)).toBe('took-over');
    expect(notices.at(-1)).toMatch(/Nothing described/);
    auto.consider(hurtInTheLair(), true);
    drain();
    expect(sent).toEqual(['l n', 'l e']);
  });

  it('steps back once rested, unless a lap has the character', () => {
    const auto = make();
    auto.consider(hurtInTheLair(), true);
    drain();
    auto.consider(peeked(hurtInTheLair(), 'n', [], Date.now()), true);
    drain();
    here = '8/914';
    auto.consider(hurtInTheLair(), true);
    // Rested to the ceiling: back through the door it came by.
    auto.consider(hurtInTheLair({ vitals: { ...hurtInTheLair().vitals, hp: 250 } }), false);
    drain();
    expect(sent).toEqual(['l n', 'n', 's']);
    expect(notices.at(-1)).toMatch(/stepping s back/);
  });

  it('leaves the walk to a lap that is running', () => {
    looping = true;
    const auto = make();
    auto.consider(hurtInTheLair(), true);
    drain();
    auto.consider(peeked(hurtInTheLair(), 'n', [], Date.now()), true);
    drain();
    here = '8/914';
    auto.consider(hurtInTheLair(), true);
    auto.consider(hurtInTheLair({ vitals: { ...hurtInTheLair().vitals, hp: 250 } }), false);
    drain();
    expect(sent).toEqual(['l n', 'n']);
  });
});

describe('everywhere else', () => {
  it('is not its business in a room with no lair, a long clock, or with the switch off', () => {
    expect(make(health(), { lairClock: () => null }).consider(hurtInTheLair(), true)).toBe(
      'not-mine'
    );
    expect(make(health(), { lairClock: () => 3600 }).consider(hurtInTheLair(), true)).toBe(
      'not-mine'
    );
    expect(make(health({ restNextDoor: false })).consider(hurtInTheLair(), true)).toBe('not-mine');
    expect(make().consider(hurtInTheLair(), false)).toBe('not-mine');
    expect(sent).toEqual([]);
  });

  it('waits out a move in flight, a marching walk and an escape rather than stepping', () => {
    for (const over of [
      { moveInFlight: () => true },
      { walking: () => true },
      { busy: () => true }
    ]) {
      expect(make(health(), over).consider(hurtInTheLair(), true)).toBe('took-over');
    }
    expect(sent).toEqual([]);
  });
});
