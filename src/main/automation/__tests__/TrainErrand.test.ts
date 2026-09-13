import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TrainErrand, type TrainPlanner } from '../TrainErrand';
import { CommandQueue } from '../CommandQueue';
import { DEFAULT_CONFIG, type AutomationConfig, type TrainConfig } from '../../../shared/config';
import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';
import type { SafetyDecision } from '../../../shared/automation';
import type { Route, TrainerChoice } from '../../../shared/world';

const automation: AutomationConfig = {
  ...DEFAULT_CONFIG.automation,
  pacing: { window: 8, minGapMs: 0, ackTimeoutMs: 1000 }
};

const train = (over: Partial<TrainConfig> = {}): TrainConfig => ({
  ...DEFAULT_CONFIG.automation.train,
  levels: true,
  ...over
});

/*
 * Paradigm's own, as measured: Titan takes 21-50 at 6,000% markup and quotes
 * 88,450 copper at level 30; Amazon takes 31-52 at 9,999%.
 */
const TITAN: TrainerChoice = {
  shop: 74,
  name: 'Titan Trainer',
  map: 3,
  room: 542,
  roomName: 'Training Area',
  cost: 88_450,
  minLevel: 21,
  maxLevel: 50
};
const AMAZON: TrainerChoice = {
  shop: 135,
  name: 'Amazon trainer',
  map: 16,
  room: 384,
  roomName: "Elders' Council Chambers",
  cost: 145_985,
  minLevel: 31,
  maxLevel: 52
};

/** A level is waiting, the purse is deep, and nothing else has the character. */
function owed(over: Partial<CharacterState> = {}): CharacterState {
  const base = structuredClone(EMPTY_CHARACTER);
  return {
    ...base,
    phase: 'in-game',
    room: { ...base.room, map: 8, number: 915, name: 'Ancient Stronghold, Stable' },
    progress: { ...base.progress, level: 30, expNeeded: 0 },
    inventory: { ...base.inventory, wealth: 200_000 },
    ...over
  };
}

const ROUTE: Route = {
  steps: [{ from: '8/915', to: '3/542' }] as unknown as Route['steps'],
  cost: 1,
  blocked: false
} as Route;

let sent: string[];
let notices: string[];
let decisions: SafetyDecision[];
let queue: CommandQueue;
let here: string | null;
let walked: Route[];
let held: number;
let released: number;

const planner = (over: Partial<TrainPlanner> = {}): TrainPlanner => ({
  here: () => here,
  trainers: () => [TITAN, AMAZON],
  routeTo: () => ROUTE,
  walk: (route) => {
    walked.push(route);
    return null;
  },
  moveInFlight: () => false,
  walking: () => false,
  busy: () => false,
  looping: () => false,
  hold: () => void (held += 1),
  release: () => void (released += 1),
  ...over
});

beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  notices = [];
  decisions = [];
  walked = [];
  held = 0;
  released = 0;
  here = '8/915';
  queue = new CommandQueue(automation, { send: (command) => sent.push(command) });
});

afterEach(() => {
  queue.dispose();
  vi.useRealTimers();
});

const make = (config = train(), over: Partial<TrainPlanner> = {}, enabled = true): TrainErrand =>
  new TrainErrand(config, enabled, queue, planner(over), {
    notice: (message) => notices.push(message),
    decided: (decision) => decisions.push(decision)
  });

const drain = (): void => void vi.advanceTimersByTime(500);

describe('going to collect the level', () => {
  it('walks to the cheapest trainer that will take this character', () => {
    make().onCharacter(owed());
    expect(walked).toHaveLength(1);
    expect(notices.join('\n')).toContain('Training Area');
  });

  /*
   * The trigger is `expNeeded <= 0` and **both figures must be stated**.
   * `expNeeded` is null until an `exp` or a sheet has been read, and unknown
   * is never the answer that sends a character across the realm.
   */
  it('does nothing while the experience owed is unread', () => {
    const base = owed();
    make().onCharacter({ ...base, progress: { ...base.progress, expNeeded: null } });
    expect(walked).toEqual([]);
  });

  it('does nothing while experience is still owed', () => {
    const base = owed();
    make().onCharacter({ ...base, progress: { ...base.progress, expNeeded: 4000 } });
    expect(walked).toEqual([]);
  });

  it('does nothing with the switch off', () => {
    make(train({ levels: false })).onCharacter(owed());
    expect(walked).toEqual([]);
  });

  /* The errand yields to everything — a fight, a move, a walk, an escape. */
  it('yields to a fight and to anything else moving the character', () => {
    make().onCharacter({ ...owed(), inCombat: true });
    expect(walked).toEqual([]);
    make(train(), { walking: () => true }).onCharacter(owed());
    expect(walked).toEqual([]);
    make(train(), { busy: () => true }).onCharacter(owed());
    expect(walked).toEqual([]);
    make(train(), { moveInFlight: () => true }).onCharacter(owed());
    expect(walked).toEqual([]);
  });

  /*
   * The purse, before the walk. At 6,000% markup level 30 costs 88,450, and a
   * walk across two maps to be told *You can not afford to train!* is an hour
   * spent for nothing.
   */
  it('refuses before walking when the purse will not cover the cost, naming both', () => {
    const base = owed();
    make().onCharacter({ ...base, inventory: { ...base.inventory, wealth: 3_324 } });
    expect(walked).toEqual([]);
    expect(notices.join('\n')).toContain('88,450');
    expect(notices.join('\n')).toContain('3,324');
    expect(decisions.at(-1)?.acted).toBe(false);
  });

  /* An unread purse is not a poor one: the counter is the authority. */
  it('walks where the purse has not been read', () => {
    const base = owed();
    make().onCharacter({ ...base, inventory: { ...base.inventory, wealth: null } });
    expect(walked).toHaveLength(1);
  });

  it('sends train on arrival, and says so when the level moves', () => {
    const errand = make();
    errand.onCharacter(owed());
    here = '3/542';
    errand.onWalkEnded(true, null, owed());
    drain();
    expect(sent).toEqual(['train']);
    const base = owed();
    errand.onCharacter({ ...base, progress: { ...base.progress, level: 31, expNeeded: 12000 } });
    expect(notices.join('\n')).toContain('31');
    expect(decisions.at(-1)?.acted).toBe(true);
  });

  /* Standing in the trainer's own room already: no walk, straight to the verb. */
  it('sends train without walking when it is already there', () => {
    here = '3/542';
    const base = owed();
    make().onCharacter({
      ...base,
      room: { ...base.room, map: 3, number: 542, name: 'Training Area' }
    });
    drain();
    expect(walked).toEqual([]);
    expect(sent).toEqual(['train']);
  });

  /*
   * The reviewer's rule: a chosen trainer that has stopped taking this
   * character is **not** silently replaced with another room.
   */
  it('refuses rather than substituting when the chosen trainer no longer takes it', () => {
    make(train({ trainer: 999 })).onCharacter(owed());
    expect(walked).toEqual([]);
    expect(notices.join('\n')).toMatch(/no longer takes/i);
  });

  it('walks to the trainer the player chose, not the cheapest', () => {
    make(train({ trainer: AMAZON.shop })).onCharacter(owed());
    expect(notices.join('\n')).toContain("Elders' Council Chambers");
  });

  it('says so once per level when the realm offers nowhere', () => {
    const errand = make(train(), { trainers: () => [] });
    errand.onCharacter(owed());
    errand.onCharacter(owed());
    errand.onCharacter(owed());
    expect(notices.filter((line) => /names no trainer/i.test(line))).toHaveLength(1);
  });

  /* One level is one attempt: a refusal does not repeat every status line. */
  it('does not try again at the same level after a refusal', () => {
    const base = owed();
    const errand = make(train(), { routeTo: () => 'no route' });
    errand.onCharacter(base);
    errand.onCharacter(base);
    expect(notices.filter((line) => /Could not walk/i.test(line))).toHaveLength(1);
  });

  it('holds a running lap and gives it back when the errand ends', () => {
    const errand = make(train(), { looping: () => true });
    errand.onCharacter(owed());
    expect(held).toBe(1);
    errand.onWalkEnded(false, 'stopped', owed());
    expect(released).toBe(1);
  });

  /*
   * The level moving is the confirmation; nothing at all coming back is the
   * one case the clock covers, and it says so rather than waiting for ever.
   */
  it('gives up out loud when the level does not move', () => {
    const errand = make();
    errand.onCharacter(owed());
    here = '3/542';
    errand.onWalkEnded(true, null, owed());
    drain();
    vi.advanceTimersByTime(11_000);
    errand.onCharacter(owed());
    expect(notices.join('\n')).toMatch(/did not move/i);
    expect(decisions.at(-1)?.acted).toBe(false);
  });
});
