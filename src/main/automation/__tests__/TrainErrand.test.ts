import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  planRefusalsWords,
  type Plan,
  type PlanRefusal,
  type PlanStep
} from '../../../shared/navigation';
import { tuning } from '../../app/tuning';
import { TrainErrand, type TrainPlanner } from '../TrainErrand';
import { CommandQueue } from '../CommandQueue';
import { DEFAULT_CONFIG, type AutomationConfig, type TrainConfig } from '../../../shared/config';
import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';
import type { SafetyDecision } from '../../../shared/automation';
import { roomId, type Route, type TrainerChoice } from '../../../shared/world';
import { t } from '../../app/i18n';

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
let fetched: Array<{ items: string[]; then: Route }>;
let fetchingNow: boolean;

/**
 * What the engine plans for a route answer: a walk; the keys a blocked route
 * names, then the last leg; or the route's reason as a refusal.
 */
const planned =
  (routeTo: (room: string) => Route | string) =>
  (room: string): Plan => {
    const route = routeTo(room);
    if (typeof route === 'string') {
      return { kind: 'refused', refusals: [{ kind: 'no-way', why: route }] };
    }
    if (!route.blocked) return { kind: 'plan', steps: [{ kind: 'walk', route }], cost: route.cost };
    const keyed = route.unlocks;
    if (keyed === undefined || keyed.blocked || (keyed.needs ?? []).length === 0) {
      return { kind: 'refused', refusals: [{ kind: 'no-way', why: route.reason ?? '' }] };
    }
    const fetches: PlanStep[] = (keyed.needs ?? []).map((item) => ({
      kind: 'buy',
      item,
      room: '1/1'
    }));
    return { kind: 'plan', steps: [...fetches, { kind: 'walk', route: keyed }], cost: keyed.cost };
  };

/** The refusal a route answer's reason becomes. */
const noWay = (why: string): string => t('navigation.noWayBecause', { why });

type PlannerOver = Partial<TrainPlanner> & { routeTo?: (room: string) => Route | string };

const planner = ({ routeTo, ...over }: PlannerOver = {}): TrainPlanner => ({
  here: () => here,
  trainers: () => [TITAN, AMAZON],
  plan: planned(routeTo ?? (() => ROUTE)),
  walk: (route) => {
    walked.push(route);
    return null;
  },
  fetch: (items, then) => {
    fetched.push({ items: items.map((item) => item.name), then });
    return null;
  },
  fetching: () => fetchingNow,
  lightFor: () => null,
  lightSettled: () => {},
  prize: () => null,
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
  fetched = [];
  fetchingNow = false;
  here = '8/915';
  queue = new CommandQueue(automation, { send: (command) => sent.push(command) });
});

afterEach(() => {
  queue.dispose();
  vi.useRealTimers();
});

const make = (config = train(), over: PlannerOver = {}, enabled = true): TrainErrand =>
  new TrainErrand(config, enabled, queue, planner(over), {
    notice: (message) => notices.push(message),
    decided: (decision) => decisions.push(decision)
  });

const drain = (): void => void vi.advanceTimersByTime(500);

/* What the errand says, built from the same copy it reads. */
const going = (trainer: TrainerChoice): string =>
  t('automation.train.going', {
    room: trainer.roomName,
    steps: ROUTE.steps.length,
    cost: trainer.cost.toLocaleString()
  });
const poor = (purse: number): string =>
  t('automation.train.refusalPoor', {
    cost: TITAN.cost.toLocaleString(),
    purse: purse.toLocaleString(),
    trainer: TITAN.name
  });
const skippedOne = (trainer: TrainerChoice, why: string): string =>
  t('automation.train.skippedOne', { trainer: trainer.name, room: trainer.roomName, why });
const unreachable = (why: string): string =>
  t('automation.train.refusalUnreachable', {
    level: 30,
    skipped: [skippedOne(TITAN, noWay(why)), skippedOne(AMAZON, noWay(why))].join('; ')
  });

describe('going to collect the level', () => {
  it('walks to the cheapest trainer that will take this character', () => {
    make().onCharacter(owed());
    expect(walked).toHaveLength(1);
    expect(notices).toContain(going(TITAN));
  });

  /*
   * At level 1 training is free everywhere, and the cheapest-first order alone
   * sent Soul past the Newhaven trainer down a road of bandits: the walk decides.
   */
  it('walks to the nearer trainer where the prices are the same', () => {
    const near: Route = { ...ROUTE, cost: 5 };
    const far: Route = { ...ROUTE, cost: 140 };
    make(train(), {
      trainers: () => [
        { ...TITAN, cost: 0 },
        { ...AMAZON, cost: 0 }
      ],
      routeTo: (room) => (room === '16/384' ? near : far)
    }).onCharacter(owed());
    expect(notices).toContain(going({ ...AMAZON, cost: 0 }));
  });

  it('walks to a much cheaper trainer rather than training in the dear one it stands in', () => {
    here = '16/384';
    make().onCharacter(
      owed({ room: { ...EMPTY_CHARACTER.room, map: 16, number: 384, name: 'x' } })
    );
    expect(notices).toContain(going(TITAN));
  });

  /*
   * The trigger is `expNeeded <= 0` and **both figures must be stated**.
   * `expNeeded` is null until an `exp` or a sheet has been read, and unknown
   * is never the answer that sends a character across the realm.
   */
  it('asks for the experience owed once a level while it is unread, and walks nowhere', () => {
    const errand = make();
    const unread = owed({ progress: { ...EMPTY_CHARACTER.progress, level: 30, expNeeded: null } });
    errand.onCharacter(unread);
    errand.onCharacter(unread);
    drain();
    expect(walked).toHaveLength(0);
    expect(sent).toEqual(['exp']);
  });

  it('asks again on the next line when the queue would not take the ask', () => {
    let refuse = true;
    const accepted: string[] = [];
    const held = new TrainErrand(
      train(),
      true,
      {
        enqueue: (intent: { command: string }) => {
          if (refuse) return false;
          accepted.push(intent.command);
          return true;
        }
      } as unknown as CommandQueue,
      planner(),
      {}
    );
    const unread = owed({ progress: { ...EMPTY_CHARACTER.progress, level: 30, expNeeded: null } });
    held.onCharacter(unread);
    refuse = false;
    held.onCharacter(unread);
    expect(accepted).toEqual(['exp']);
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
    expect(notices).toContain(poor(3_324));
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
    expect(notices).toEqual([poor(3_324)]);
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
    expect(notices).toContain(t('automation.train.levelled', { level: 31 }));
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
    expect(notices).toContain(t('automation.train.refusalTrainerStale', { level: 30 }));
  });

  it('walks to the trainer the player chose, not the cheapest', () => {
    make(train({ trainer: AMAZON.shop })).onCharacter(owed());
    expect(notices).toContain(going(AMAZON));
  });

  it('says so once per level when the realm offers nowhere', () => {
    const errand = make(train(), { trainers: () => [] });
    errand.onCharacter(owed());
    errand.onCharacter(owed());
    errand.onCharacter(owed());
    expect(notices).toEqual([t('automation.train.refusalNowhere', { level: 30 })]);
  });

  /* One level is one attempt: a refusal does not repeat every status line. */
  it('does not try again at the same level after a refusal', () => {
    const base = owed();
    const errand = make(train(), { routeTo: () => 'no route' });
    errand.onCharacter(base);
    errand.onCharacter(base);
    expect(notices).toEqual([unreachable('no route')]);
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
    expect(notices).toEqual([
      t('automation.train.skipping', { skipped: skippedOne(TITAN, noWay('No way there at all')) }),
      going(AMAZON)
    ]);
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
    expect(notices).toEqual([unreachable('No way there at all')]);
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
    expect(notices).toEqual([unreachable('No way there at all')]);
    here = '8/915';
    vi.advanceTimersByTime(61_000);
    errand.onCharacter(owed());
    // Back in the room it was asked from, clock passed: not planned again.
    expect(planned).toBe(2);
    here = '1/2152';
    errand.onCharacter(owed());
    // Another room and the clock passed: planned again; same outcome, nothing new said.
    expect(planned).toBe(4);
    expect(notices).toEqual([unreachable('No way there at all')]);
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
    expect(notices).toEqual([
      unreachable('No way there at all'),
      unreachable('Crypt is locked — needs bone key')
    ]);
  });

  it('never substitutes for a chosen trainer that cannot be reached', () => {
    make(train({ trainer: TITAN.shop }), { routeTo: () => BLOCKED }).onCharacter(owed());
    expect(walked).toEqual([]);
    expect(notices).toEqual([
      t('automation.train.refusalNoRoute', {
        room: TITAN.roomName,
        why: noWay('No way there at all')
      })
    ]);
  });

  it('holds a running lap and gives it back when the errand ends', () => {
    const errand = make(train(), { looping: () => true });
    errand.onCharacter(owed());
    expect(held).toBe(1);
    errand.onWalkEnded(false, 'stopped', owed());
    expect(released).toBe(1);
  });

  /*
   * Todo 69: after a level the stat screen opens, and its hold drops what is
   * queued, the next level's train with it. The attempt goes back, and the
   * level is asked for again once the hold lifts.
   */
  it('asks again for a train the stat screen dropped, saying nothing', () => {
    // A queue that takes the intent and never sends it: the hold dropped it.
    const taken: Array<{ command: string; onSent?: () => void }> = [];
    const errand = new TrainErrand(
      train(),
      true,
      {
        offer: (intent: { command: string; onSent?: () => void }) => {
          taken.push(intent);
          return 'queued';
        }
      } as unknown as CommandQueue,
      planner(),
      { notice: (message) => notices.push(message) }
    );
    here = '3/542';
    errand.onCharacter(owed());
    expect(taken.map((intent) => intent.command)).toEqual(['train']);
    vi.advanceTimersByTime(11_000);
    errand.onCharacter(owed());
    expect(notices).not.toContain(t('automation.train.refusalUnanswered', { trainer: TITAN.name }));
    errand.onCharacter(owed());
    expect(taken.map((intent) => intent.command)).toEqual(['train', 'train']);
  });

  it('tries a level again a while after its train moved nothing', () => {
    const errand = make();
    errand.onCharacter(owed());
    here = '3/542';
    errand.onWalkEnded(true, null, owed());
    drain();
    vi.advanceTimersByTime(11_000);
    errand.onCharacter(owed());
    sent.length = 0;
    errand.onCharacter(owed());
    drain();
    expect(sent).not.toContain('train');
    vi.advanceTimersByTime(tuning().train.retryMs);
    errand.onCharacter(owed());
    drain();
    expect(sent).toContain('train');
    // Moving nothing again is recorded, and said only the once.
    vi.advanceTimersByTime(11_000);
    errand.onCharacter(owed());
    const unanswered = t('automation.train.refusalUnanswered', { trainer: TITAN.name });
    expect(notices.filter((notice) => notice === unanswered)).toHaveLength(1);
    expect(decisions.filter((decision) => decision.refused === unanswered)).toHaveLength(2);
  });

  it('keeps waiting on a train that joins the one still queued, and times it from its send', () => {
    // Held behind a half-typed line: the second offer joins the first.
    const taken: Array<{ command: string; onSent?: () => void }> = [];
    const errand = new TrainErrand(
      train(),
      true,
      {
        offer: (intent: { command: string; onSent?: () => void }) => {
          taken.push(intent);
          return taken.length === 1 ? 'queued' : 'joined';
        }
      } as unknown as CommandQueue,
      planner(),
      { notice: (message) => notices.push(message) }
    );
    here = '3/542';
    errand.onCharacter(owed());
    vi.advanceTimersByTime(11_000);
    errand.onCharacter(owed());
    errand.onCharacter(owed());
    expect(taken).toHaveLength(2);
    expect(errand.busy).toBe(true);
    // Enter: the line goes, and the joined proposal speaks for it.
    taken.at(-1)?.onSent?.();
    vi.advanceTimersByTime(11_000);
    errand.onCharacter(owed());
    expect(notices).toContain(t('automation.train.refusalUnanswered', { trainer: TITAN.name }));
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
    expect(notices).toContain(t('automation.train.refusalUnanswered', { trainer: TITAN.name }));
    expect(decisions.at(-1)?.acted).toBe(false);
  });
});

/*
 * 2026-10-01: the Super Mystic Trainer in 1/2240 is behind a Large Chamber
 * door whose guardian drops the key, and the trip fell back to a trainer at
 * 45,445 copper. The key is fetched on the way.
 */
describe('a trainer behind a keyed door', () => {
  const BLOCKED = { steps: [], cost: 0, blocked: true, reason: 'locked' } as unknown as Route;
  const KEYED = {
    ...ROUTE,
    needs: [{ id: 338, name: 'iron key' }]
  } as Route;
  const keyed = (over: PlannerOver = {}): TrainErrand =>
    make(train(), {
      trainers: () => [TITAN],
      routeTo: () => ({ ...BLOCKED, unlocks: KEYED }),
      ...over
    });

  it('hands the key to the item errand, with the walk to the trainer owed', () => {
    keyed().onCharacter(owed());
    // The last leg is the plan's walk after its last fetch, steps and cost.
    expect(fetched).toEqual([
      { items: ['iron key'], then: { steps: KEYED.steps, cost: KEYED.cost, blocked: false } }
    ]);
    expect(walked).toEqual([]);
    expect(notices).toContain(
      t('automation.train.goingKeyed', {
        room: TITAN.roomName,
        items: 'iron key',
        cost: TITAN.cost.toLocaleString()
      })
    );
  });

  it('counts the trainer as reached when the levels ahead are priced', () => {
    const [ahead] = keyed().trainersAhead([30], 'k');
    expect(ahead).toMatchObject({ trainer: TITAN, reachable: true });
  });

  it('lets the fetch walk round the lair, then trains on arrival', () => {
    const errand = keyed();
    errand.onCharacter(owed());
    fetchingNow = true;
    here = '1/2224';
    errand.onWalkEnded(false, 'lap leg', owed());
    errand.onCharacter(owed());
    // Still the trip's: the lap leg ending is the fetch's own.
    expect(errand.busy).toBe(true);
    expect(released).toBe(0);
    fetchingNow = false;
    here = '3/542';
    errand.onWalkEnded(true, null, owed());
    drain();
    expect(sent).toEqual(['train']);
  });

  it('ends the trip out loud when the fetch ends without getting there', () => {
    const errand = keyed();
    errand.onCharacter(owed());
    fetchingNow = true;
    errand.onCharacter(owed());
    expect(errand.busy).toBe(true);
    fetchingNow = false;
    errand.onCharacter(owed());
    expect(errand.busy).toBe(false);
    expect(notices).toContain(
      t('automation.train.refusalNotReached', {
        room: TITAN.roomName,
        why: t('automation.train.whyFetch')
      })
    );
  });

  it('says the walk stopped, not the key, when the key is in the pack', () => {
    const errand = keyed();
    errand.onCharacter(owed());
    const base = owed();
    const holding: CharacterState = {
      ...base,
      inventory: {
        ...base.inventory,
        items: [{ name: 'iron key' } as CharacterState['inventory']['items'][number]]
      }
    };
    errand.onCharacter(holding);
    expect(notices).toContain(
      t('automation.train.refusalNotReached', {
        room: TITAN.roomName,
        why: t('automation.train.whyStopped')
      })
    );
  });

  it('is out of reach when a key cannot be got, and nothing is fetched', () => {
    const refusals: PlanRefusal[] = [
      { kind: 'fight', item: { id: 344, name: 'stone key' }, monster: 'ogre', survives: 0.5 }
    ];
    const why = planRefusalsWords(refusals, t);
    keyed({ plan: () => ({ kind: 'refused', refusals }) }).onCharacter(owed());
    expect(fetched).toEqual([]);
    expect(notices).toContain(
      t('automation.train.refusalUnreachable', { level: 30, skipped: skippedOne(TITAN, why) })
    );
  });

  /* A way that wants a room emptied first is planned, and said, but not walked. */
  it('says a way that wants a room cleared first, and walks nothing', () => {
    const plan: Plan = {
      kind: 'plan',
      steps: [
        { kind: 'walk', route: ROUTE },
        { kind: 'clear', room: '12/1799', name: 'Deep Dark Pit', monsters: ['hydra'] },
        { kind: 'walk', route: ROUTE }
      ],
      cost: 3
    };
    keyed({ plan: () => plan }).onCharacter(owed());
    expect(walked).toEqual([]);
    const why = t('automation.train.refusalClearing', {
      roomName: 'Deep Dark Pit',
      monsters: 'hydra'
    });
    expect(notices).toContain(
      t('automation.train.refusalUnreachable', { level: 30, skipped: skippedOne(TITAN, why) })
    );
  });

  it('is out of reach when no key the realm names opens the way', () => {
    keyed({ routeTo: () => BLOCKED }).onCharacter(owed());
    expect(fetched).toEqual([]);
    expect(notices).toContain(
      t('automation.train.refusalUnreachable', {
        level: 30,
        skipped: skippedOne(TITAN, noWay('locked'))
      })
    );
  });
});

/* Every class's Super trainer tomb puts out that class's reward: clawed gloves for a Mystic. */
describe("the trainer's reward for the class", () => {
  const inTheRoom = (floor: string[]): CharacterState => {
    const base = owed();
    return {
      ...base,
      room: {
        ...base.room,
        map: 3,
        number: 542,
        name: 'Training Area',
        items: floor.map((name) => ({ name }) as CharacterState['room']['items'][number])
      }
    };
  };

  it('is picked up before the train where the floor shows it', () => {
    here = '3/542';
    make(train(), { prize: () => ({ name: 'clawed gloves' }) }).onCharacter(
      inTheRoom(['clawed gloves'])
    );
    drain();
    expect(sent).toEqual(['get clawed gloves', 'train']);
    expect(notices).toContain(t('automation.train.takingPrize', { item: 'clawed gloves' }));
  });

  it('is said to be gone where the floor does not show it, and the train still goes', () => {
    here = '3/542';
    make(train(), { prize: () => ({ name: 'clawed gloves' }) }).onCharacter(inTheRoom([]));
    drain();
    expect(sent).toEqual(['train']);
    expect(notices).toContain(t('automation.train.prizeGone', { item: 'clawed gloves' }));
  });
});

/*
 * 2026-10-01: the planner was told training costs 450 copper while the only
 * trainer a route reached for the level asked 45,445. A plan reads the price
 * the trip would pay.
 */
describe('the trainer each level ahead goes to', () => {
  const KEY = 'level 30';
  const SYSOP: TrainerChoice = { ...TITAN, shop: 1, name: 'Sysop', room: 1, cost: 450 };

  it('is the one a route reaches, not the cheapest the realm lists', () => {
    const errand = make(train(), {
      trainers: () => [SYSOP, TITAN],
      routeTo: (room) => (room === '3/1' ? 'no route' : ROUTE)
    });
    expect(errand.trainersAhead([30], KEY)).toEqual([
      { level: 30, trainer: TITAN, reachable: true }
    ]);
  });

  it('says the cheapest is out of reach when no route reaches any, and nothing for a level none takes', () => {
    const errand = make(train(), {
      trainers: (level) => (level === 31 ? [] : [SYSOP, TITAN]),
      routeTo: () => 'no route'
    });
    expect(errand.trainersAhead([30, 31], KEY)).toEqual([
      { level: 30, trainer: SYSOP, reachable: false },
      null
    ]);
  });

  it('plans each trainer room once, however many levels share it', () => {
    let planned = 0;
    const errand = make(train(), {
      trainers: () => [TITAN, { ...AMAZON, cost: TITAN.cost }],
      routeTo: () => {
        planned += 1;
        return ROUTE;
      }
    });
    errand.trainersAhead([30, 31, 32], KEY);
    expect(planned).toBe(2);
  });

  /*
   * 2026-10-01: a plan asked for the price every few seconds while Soul stood
   * still, and the one level-10 trainer no route reached cost a search of the
   * whole realm, about four seconds, every time.
   */
  /* 2026-10-01: planned again on every step of a walk, 54 s of main's 240 s. */
  it('keeps the routes wherever the character walks, and plans again once stale', () => {
    let planned = 0;
    const errand = make(train(), {
      routeTo: () => {
        planned += 1;
        return 'no route';
      }
    });
    errand.trainersAhead([30], KEY);
    errand.trainersAhead([30, 31], KEY);
    expect(planned).toBe(2);
    here = '8/916';
    errand.trainersAhead([30], KEY);
    expect(planned).toBe(2);
    vi.advanceTimersByTime(tuning().train.aheadMs);
    errand.trainersAhead([30], KEY);
    expect(planned).toBe(4);
  });

  it('plans the level in hand, and leaves the levels past the budget not yet known', () => {
    let planned = 0;
    const errand = make(train(), {
      trainers: (level = 30) =>
        level === 30 ? [TITAN] : level === 31 ? [AMAZON] : [{ ...AMAZON, map: 9, room: level }],
      routeTo: () => {
        planned += 1;
        return ROUTE;
      }
    });
    const levels = Array.from({ length: tuning().train.aheadPlans + 2 }, (_, i) => 30 + i);
    const first = errand.trainersAhead(levels, KEY);
    expect(first[0]).toMatchObject({ trainer: TITAN, reachable: true });
    expect(first.at(-1)).toMatchObject({ reachable: null });
    expect(planned).toBe(tuning().train.aheadPlans);
    // The next call fills in what the last one left.
    const second = errand.trainersAhead(levels, KEY);
    expect(second.every((ahead) => ahead?.reachable === true)).toBe(true);
  });

  it('plans again in the same room once what a route is planned on moves, and not on a reload', () => {
    let planned = 0;
    const errand = make(train(), {
      trainers: () => [TITAN, { ...AMAZON, cost: TITAN.cost }],
      routeTo: () => {
        planned += 1;
        return ROUTE;
      }
    });
    errand.trainersAhead([30], KEY);
    errand.trainersAhead([30], KEY);
    expect(planned).toBe(2);
    // A level trained by hand, a key bought, an exit refused: the traveller is another.
    errand.trainersAhead([30], 'level 31');
    expect(planned).toBe(4);
    // A reload keeps them: what it could change about a route is in the key (2026-10-02).
    errand.configure(train(), true);
    errand.trainersAhead([30], 'level 31');
    expect(planned).toBe(4);
  });

  /* 2026-10-02: three trainers at 45,445 copper planned, about 1.5 s each, behind one at 2,700. */
  it('plans no dearer trainer once a cheaper one is reached by a walk that survives', () => {
    const planned: string[] = [];
    const errand = make(train(), {
      routeTo: (room) => {
        planned.push(room);
        return ROUTE;
      }
    });
    expect(errand.trainersAhead([30], KEY)[0]).toMatchObject({ trainer: TITAN, reachable: true });
    expect(planned).toEqual([roomId(TITAN.map, TITAN.room)]);
  });

  it('plans on past a cheaper trainer whose walk is expected to kill', () => {
    const planned: string[] = [];
    const deadly = {
      ...ROUTE,
      steps: [{ from: '8/915', to: '3/542', name: 'Lair', deadly: true }]
    } as unknown as Route;
    const errand = make(train(), {
      routeTo: (room) => {
        planned.push(room);
        return room === roomId(TITAN.map, TITAN.room) ? deadly : ROUTE;
      }
    });
    expect(errand.trainersAhead([30], KEY)[0]).toMatchObject({ trainer: AMAZON, reachable: true });
    expect(planned).toHaveLength(2);
  });

  it('is only the chosen trainer where the player chose one', () => {
    const errand = make(train({ trainer: AMAZON.shop }));
    expect(errand.trainersAhead([30], KEY)[0]?.trainer).toEqual(AMAZON);
    const gone = make(train({ trainer: 999 }));
    expect(gone.trainersAhead([30], KEY)).toEqual([null]);
  });
});

/* A trainer through rooms too dark to see in: the light is fetched first (todo 11). */
describe('a trainer through the dark', () => {
  const LIGHT = { items: [{ id: 175, name: 'torch', count: 1, dark: true }], said: 'buying' };

  it('hands the light to the item errand, with the walk to the trainer owed', () => {
    const settled: Array<string | null> = [];
    make(train(), {
      trainers: () => [TITAN],
      lightFor: () => LIGHT,
      lightSettled: (_, refused) => void settled.push(refused)
    }).onCharacter(owed());
    expect(fetched).toEqual([{ items: ['torch'], then: ROUTE }]);
    expect(walked).toEqual([]);
    expect(settled).toEqual([null]);
    expect(notices).toContain(
      t('automation.train.goingFetching', {
        room: TITAN.roomName,
        items: 'torch',
        cost: TITAN.cost.toLocaleString()
      })
    );
  });

  it('walks on without it when it cannot be fetched, the refusal handed back', () => {
    const settled: Array<string | null> = [];
    make(train(), {
      trainers: () => [TITAN],
      lightFor: () => LIGHT,
      lightSettled: (_, refused) => void settled.push(refused),
      fetch: () => 'Auto-Buy is off'
    }).onCharacter(owed());
    expect(walked).toEqual([ROUTE]);
    expect(settled).toEqual(['Auto-Buy is off']);
    expect(notices).toContain(going(TITAN));
  });
});
