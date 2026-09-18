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

  /* Todo 112: the purse is the fact the refusal stands on, so the purse moving asks again. */
  it('asks again once the purse can pay, and not before', () => {
    const base = owed();
    const errand = make();
    const broke = { ...base, inventory: { ...base.inventory, wealth: 3_324 } };
    errand.onCharacter(broke);
    errand.onCharacter(broke);
    errand.onCharacter({ ...base, inventory: { ...base.inventory, wealth: 50_000 } });
    expect(walked).toEqual([]);
    expect(notices.filter((line) => /carries/.test(line))).toHaveLength(1);
    errand.onCharacter({ ...base, inventory: { ...base.inventory, wealth: 88_450 } });
    expect(walked).toHaveLength(1);
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

  /*
   * Todo 107: a character with two banked levels collected one and stood
   * under the other for ever, because a success wrote the *new* level into
   * `attempted`. The level moving spends the attempt; the next is asked about
   * once the experience figure has been said again (`user-levels` leaves a
   * stale 0 behind and the staleness table asks `exp`), or after the confirm
   * window if nothing answers.
   */
  it('collects a second banked level once the experience figure is said again', () => {
    const errand = make();
    errand.onCharacter(owed());
    here = '3/542';
    errand.onWalkEnded(true, null, owed());
    drain();
    expect(sent).toEqual(['train']);
    const base = owed();
    // Welcome to level 31; `expNeeded` still reads the stale 0.
    const levelled = { ...base, progress: { ...base.progress, level: 31, expNeeded: 0 } };
    errand.onCharacter(levelled);
    errand.onCharacter(levelled);
    drain();
    expect(sent).toEqual(['train']);
    // The `exp` answer lands: the figure is fresh and still says a level is owed.
    errand.onBlock({
      seq: 1,
      at: 0,
      type: 'user-experience',
      domain: 'status',
      terminator: 'newline',
      groups: {},
      text: 'Exp: 1 Level: 31 Exp needed for next level: 0 (12)',
      confidence: 1
    });
    errand.onCharacter(levelled);
    drain();
    expect(sent).toEqual(['train', 'train']);
  });

  it('asks again after the confirm window when the experience figure is never said again', () => {
    const errand = make();
    errand.onCharacter(owed());
    here = '3/542';
    errand.onWalkEnded(true, null, owed());
    drain();
    const base = owed();
    const levelled = { ...base, progress: { ...base.progress, level: 31, expNeeded: 0 } };
    errand.onCharacter(levelled);
    vi.advanceTimersByTime(11_000);
    errand.onCharacter(levelled);
    drain();
    expect(sent).toEqual(['train', 'train']);
  });

  /*
   * Todo 113: the arbiter refuses while the stat screen has the keyboard, and
   * the attempt was marked before the queue agreed to carry it. A refused
   * enqueue is *not now*: the mark goes back and the next status line asks.
   */
  it('asks again after the queue refused the verb, rather than spending the level', () => {
    here = '3/542';
    const base = owed();
    const there = { ...base, room: { ...base.room, map: 3, number: 542, name: 'Training Area' } };
    queue.hold('the stat screen has the keyboard');
    const errand = make();
    errand.onCharacter(there);
    drain();
    expect(sent).toEqual([]);
    queue.release();
    errand.onCharacter(there);
    drain();
    expect(sent).toEqual(['train']);
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
    expect(notices.filter((line) => /Nothing walked/i.test(line))).toHaveLength(1);
  });

  /*
   * Reach is the filter, not the tiebreak (todo 102). On the test realm the
   * two cheapest trainers that take every level are Sysop rooms nothing a
   * player walks can enter; the errand chose one, said *0 steps* and gave the
   * level up. A blocked route is a reason, and the next trainer is walked.
   */
  const BLOCKED: Route = {
    steps: [] as unknown as Route['steps'],
    cost: 0,
    blocked: true,
    reason: 'No way there at all'
  } as Route;

  it('skips a trainer no route reaches and walks to the next, saying which it skipped', () => {
    make(train(), { routeTo: (room) => (room === '3/542' ? BLOCKED : ROUTE) }).onCharacter(owed());
    expect(walked).toEqual([ROUTE]);
    const said = notices.join('\n');
    expect(said).toMatch(/Skipping.*Titan Trainer.*No way there at all/);
    expect(said).toContain("Elders' Council Chambers");
    expect(said).not.toContain('0 steps');
  });

  it('refuses once when no trainer can be reached, naming every one, and plans nothing more from that room', () => {
    let planned = 0;
    const errand = make(train(), {
      routeTo: () => {
        planned += 1;
        return BLOCKED;
      }
    });
    errand.onCharacter(owed());
    errand.onCharacter(owed());
    errand.onCharacter(owed());
    expect(walked).toEqual([]);
    expect(notices.filter((line) => /no trainer .* can be walked to/i.test(line))).toHaveLength(1);
    expect(notices.join('\n')).toMatch(/Titan Trainer.*Amazon trainer/);
    // Two trainers, planned once each; the two later status lines planned nothing.
    expect(planned).toBe(2);
    expect(decisions.at(-1)?.acted).toBe(false);
  });

  /*
   * Todo 103: the sentence names every trainer and why, and a lap changes room
   * every three seconds. The routes are planned again only from another room
   * once `tuning.train.reaskMs` has passed, and the same outcome is said once.
   */
  it('plans again only from another room after the clock, and says the same outcome once', () => {
    let planned = 0;
    const errand = make(train(), {
      routeTo: () => {
        planned += 1;
        return BLOCKED;
      }
    });
    errand.onCharacter(owed());
    here = '1/2150';
    errand.onCharacter(owed());
    here = '1/2151';
    errand.onCharacter(owed());
    // Three rooms inside the clock: planned once, said once.
    expect(planned).toBe(2);
    expect(notices.filter((line) => /can be walked to/i.test(line))).toHaveLength(1);
    here = '8/915';
    vi.advanceTimersByTime(61_000);
    errand.onCharacter(owed());
    // Back in the room it was asked from, clock passed: not planned again.
    expect(planned).toBe(2);
    here = '1/2152';
    errand.onCharacter(owed());
    // Another room and the clock passed: planned again; same outcome, nothing new said.
    expect(planned).toBe(4);
    expect(notices.filter((line) => /can be walked to/i.test(line))).toHaveLength(1);
  });

  it('says a changed outcome, once', () => {
    let reason = 'No way there at all';
    const errand = make(train(), {
      routeTo: () => ({ ...BLOCKED, reason }) as Route
    });
    errand.onCharacter(owed());
    vi.advanceTimersByTime(61_000);
    here = '1/2150';
    reason = 'Crypt is locked — needs bone key';
    errand.onCharacter(owed());
    const said = notices.filter((line) => /can be walked to/i.test(line));
    expect(said).toHaveLength(2);
    expect(said[1]).toContain('bone key');
  });

  it('never substitutes for a chosen trainer that cannot be reached', () => {
    make(train({ trainer: TITAN.shop }), { routeTo: () => BLOCKED }).onCharacter(owed());
    expect(walked).toEqual([]);
    const said = notices.join('\n');
    expect(said).toMatch(/Could not walk to Training Area.*No way there at all/);
    expect(said).not.toContain("Elders' Council Chambers");
    expect(said).not.toContain('0 steps');
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
