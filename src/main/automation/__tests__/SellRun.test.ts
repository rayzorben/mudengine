import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { t } from '../../app/i18n';
import { CommandQueue } from '../CommandQueue';
import { SellRun, type SellRunPlanner } from '../SellRun';
import type { SafetyDecision } from '../../../shared/automation';
import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';
import { DEFAULT_CONFIG, type AutomationConfig } from '../../../shared/config';
import { wireItem } from '../../../shared/entities';
import type { GearLeg } from '../../../shared/gearTrip';
import type { SellItem, SellRunPlan, SellRunProgress } from '../../../shared/sellRun';
import type { Route } from '../../../shared/world';

const automation: AutomationConfig = {
  ...DEFAULT_CONFIG.automation,
  pacing: { window: 8, minGapMs: 0, ackTimeoutMs: 1000 }
};
const FLOOR = '1/1';
const STORE = '1/20';
const ROUTE = { steps: [{ from: FLOOR, to: STORE }], cost: 1, blocked: false } as unknown as Route;
const LEG: GearLeg = { steps: 3, fights: [], hazards: [], walls: [], needs: [], blocked: null };
const HERE: GearLeg = { ...LEG, steps: 0 };
const ROBE: SellItem = { name: 'silk robe', item: 1, count: 1, copper: 825, weight: 40 };
const SWORD: SellItem = { name: 'iron sword', item: 2, count: 1, copper: 300, weight: 30 };

/** Pick the sword up where the character stands, then sell it and the robe at the armoury. */
const PLAN: SellRunPlan = {
  from: FLOOR,
  stops: [
    { kind: 'floor', round: 1, room: FLOOR, place: 'Town Square', items: [SWORD], leg: HERE },
    {
      kind: 'shop',
      round: 1,
      room: STORE,
      place: 'Armoury',
      shop: 'Armoury',
      items: [ROBE, SWORD],
      leg: LEG
    }
  ],
  moves: 3,
  copper: 1125,
  rounds: 1,
  left: []
};
/** What a second plan is once a take failed: back to the floor, then the armoury. */
const AGAIN: SellRunPlan = {
  ...PLAN,
  stops: [
    { ...PLAN.stops[0]!, leg: LEG },
    { ...PLAN.stops[1]!, items: [SWORD] }
  ]
};

function carrying(...pack: string[]): CharacterState {
  const base = structuredClone(EMPTY_CHARACTER);
  return {
    ...base,
    phase: 'in-game',
    inventory: { ...base.inventory, listedAt: 1, items: pack.map((name) => wireItem(name)) }
  };
}

let sent: string[];
let notices: string[];
let decisions: SafetyDecision[];
let progress: Array<SellRunProgress | null>;
let queue: CommandQueue;
let here: string | null;
let current: CharacterState;
let log: string[];

const planner = (over: Partial<SellRunPlanner> = {}): SellRunPlanner => ({
  here: () => here,
  pace: () => 'walking',
  current: () => current,
  routeTo: (room) => {
    log.push(`route:${room}`);
    return ROUTE;
  },
  walk: () => {
    log.push('walk');
    return null;
  },
  moveInFlight: () => false,
  walking: () => false,
  busy: () => false,
  escaping: () => false,
  looping: () => true,
  hold: () => void log.push('hold'),
  release: () => void log.push('release'),
  choices: () => [],
  plan: () => Promise.resolve(PLAN),
  again: (floor, room) => {
    log.push(`again:${room}:${floor.map((item) => `${item.count} ${item.name}`).join(',')}`);
    return Promise.resolve(AGAIN);
  },
  switchedOnFor: (start) => start(),
  stopWalk: (reason) => void log.push(`stop walk:${reason}`),
  ...over
});

beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  notices = [];
  decisions = [];
  progress = [];
  here = FLOOR;
  current = carrying('silk robe');
  log = [];
  queue = new CommandQueue(automation, { send: (command) => sent.push(command) });
});

afterEach(() => {
  queue.dispose();
  vi.useRealTimers();
});

const make = (over: Partial<SellRunPlanner> = {}, enabled = true): SellRun =>
  new SellRun(enabled, queue, planner(over), {
    notice: (m) => notices.push(m),
    decided: (d) => decisions.push(d),
    sellRun: (p) => progress.push(p)
  });
const drain = (): void => void vi.advanceTimersByTime(500);
const see = (run: SellRun, state: CharacterState): void => {
  current = state;
  run.onCharacter(state);
  drain();
};
const arrive = (run: SellRun, room: string): void => {
  here = room;
  run.onWalkEnded(true, null, current);
  drain();
};

describe('a sell run', () => {
  it('picks up what lies here, sells everything at the one shop, and gives the lap back', async () => {
    const run = make();
    expect(await run.start([])).toBeNull();
    drain();
    expect(log).toEqual(['hold']);
    expect(sent).toEqual(['get iron sword']);
    expect(run.progress?.stage).toBe('taking');

    see(run, carrying('silk robe', 'iron sword'));
    expect(log.slice(-2)).toEqual([`route:${STORE}`, 'walk']);
    expect(run.progress?.stage).toBe('walking');

    arrive(run, STORE);
    expect(sent.at(-1)).toBe('sell silk robe');
    see(run, carrying('iron sword'));
    expect(sent.at(-1)).toBe('sell iron sword');
    see(run, carrying());

    expect(run.busy).toBe(false);
    expect(log.at(-1)).toBe('release');
    expect(progress.at(-1)).toMatchObject({
      stage: 'ended',
      taken: ['iron sword'],
      sold: ['silk robe', 'iron sword'],
      missed: [],
      done: true
    });
    expect(notices.at(-1)).toBe(t('automation.sellRun.done', { sold: 2, missed: 0 }));
  });

  it('goes back for what a get did not pick up once the round has sold something', async () => {
    const run = make();
    await run.start([]);
    drain();
    expect(sent).toEqual(['get iron sword']);
    // The pack never gains the sword: too heavy, as the server refuses it.
    vi.advanceTimersByTime(20_000);
    see(run, carrying('silk robe'));
    expect(notices).toContain(
      t('automation.sellRun.notTaken', { items: 'iron sword', place: 'Town Square' })
    );

    arrive(run, STORE);
    // The sword is still in its room, so only the robe is offered.
    expect(sent.at(-1)).toBe('sell silk robe');
    see(run, carrying());
    expect(sent.filter((command) => command.startsWith('sell'))).toEqual(['sell silk robe']);
    expect(log).toContain(`again:${FLOOR}:1 iron sword`);
    expect(run.progress?.stage).toBe('planning');

    await vi.advanceTimersByTimeAsync(0);
    expect(run.busy).toBe(true);
    expect(run.progress?.plan).toBe(AGAIN);
    arrive(run, FLOOR);
    expect(sent.at(-1)).toBe('get iron sword');
    see(run, carrying('iron sword'));
    arrive(run, STORE);
    expect(sent.at(-1)).toBe('sell iron sword');
    see(run, carrying());
    expect(progress.at(-1)).toMatchObject({ sold: ['silk robe', 'iron sword'], done: true });
  });

  it('leaves what it could not pick up when the round sold nothing', async () => {
    current = carrying();
    const run = make({ plan: () => Promise.resolve({ ...PLAN, stops: [PLAN.stops[0]!] }) });
    await run.start([]);
    drain();
    vi.advanceTimersByTime(20_000);
    see(run, carrying());
    expect(log.some((line) => line.startsWith('again'))).toBe(false);
    expect(notices).toContain(t('automation.sellRun.leftLying', { items: 'iron sword' }));
    expect(progress.at(-1)).toMatchObject({ missed: ['iron sword'], done: true });
  });

  it('never sells a worn copy', async () => {
    const worn = carrying();
    worn.inventory.items = [wireItem('silk robe', { equipped: true })];
    current = worn;
    here = STORE;
    const run = make({ plan: () => Promise.resolve({ ...PLAN, stops: [PLAN.stops[1]!] }) });
    await run.start([]);
    drain();
    expect(sent).toEqual([]);
    expect(notices).toContain(
      t('automation.sellRun.notCarried', { items: 'silk robe, iron sword' })
    );
    expect(progress.at(-1)).toMatchObject({ sold: [], done: true });
  });

  it('ends at Stop, takes back its verbs and stops its walk', async () => {
    const run = make();
    await run.start([]);
    drain();
    see(run, carrying('silk robe', 'iron sword'));
    run.stop();
    const why = t('automation.sellRun.stoppedByPlayer');
    expect(log.slice(-2)).toEqual(['release', `stop walk:${why}`]);
    expect(progress.at(-1)).toMatchObject({ stage: 'ended', done: false });
    arrive(run, STORE);
    expect(sent).toEqual(['get iron sword']);
  });

  it('refuses in a fight, and says the plan`s own refusal', async () => {
    const fighting = { ...carrying('silk robe'), inCombat: true };
    current = fighting;
    const run = make();
    expect(await run.start([])).toBe(t('automation.hostTrip.refusalFighting'));
    expect(decisions.at(-1)).toMatchObject({ acted: false });

    current = carrying();
    const refusal = 'nothing picked can be sold';
    const none = make({ plan: () => Promise.resolve({ ...PLAN, stops: [], refusal }) });
    expect(await none.start([])).toBe(refusal);
    expect(none.busy).toBe(false);
  });

  it('waits out a fight on the way and plans the leg again', async () => {
    here = '1/5';
    const run = make({ plan: () => Promise.resolve({ ...PLAN, stops: [PLAN.stops[1]!] }) });
    await run.start([]);
    const fighting = { ...carrying('silk robe', 'iron sword'), inCombat: true };
    current = fighting;
    run.onWalkEnded(false, 'a fight', fighting);
    expect(run.busy).toBe(true);
    see(run, carrying('silk robe', 'iron sword'));
    expect(log.filter((line) => line === 'walk')).toHaveLength(2);
  });

  it('does not set off when Stop comes while the plan is being made', async () => {
    let planned: (plan: SellRunPlan) => void = () => undefined;
    const run = make({ plan: () => new Promise((resolve) => (planned = resolve)) });
    const started = run.start([]);
    run.stop();
    planned(PLAN);
    const dropped = t('automation.sellRun.refusalDropped');
    expect(await started).toBe(dropped);
    drain();
    expect(run.busy).toBe(false);
    expect(sent).toEqual([]);
    expect(decisions.at(-1)).toMatchObject({ acted: false, refused: dropped });
  });

  it('counts every copy the pack no longer holds as not sold', async () => {
    current = carrying('iron sword');
    here = STORE;
    const three = { ...SWORD, count: 3 };
    const stop = { ...PLAN.stops[1]!, items: [three] };
    const run = make({ plan: () => Promise.resolve({ ...PLAN, stops: [stop] }) });
    await run.start([]);
    drain();
    expect(sent).toEqual(['sell iron sword']);
    see(run, carrying());
    expect(progress.at(-1)).toMatchObject({
      sold: ['iron sword'],
      missed: ['iron sword', 'iron sword']
    });
  });
});
