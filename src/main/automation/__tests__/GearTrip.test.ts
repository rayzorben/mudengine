import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { t } from '../../app/i18n';
import { tuning } from '../../app/tuning';
import { CommandQueue } from '../CommandQueue';
import { GearTrip, type GearTripPlanner } from '../GearTrip';
import type { SafetyDecision } from '../../../shared/automation';
import { domainOf, type Block, type BlockType } from '../../../shared/blocks';
import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';
import { DEFAULT_CONFIG, type AutomationConfig } from '../../../shared/config';
import { wireItem } from '../../../shared/entities';
import type { GearLeg, GearTripPlan, GearTripProgress } from '../../../shared/gearTrip';
import type { Route } from '../../../shared/world';

const automation: AutomationConfig = {
  ...DEFAULT_CONFIG.automation,
  pacing: { window: 8, minGapMs: 0, ackTimeoutMs: 1000 }
};
const BANK = '1/2170';
const STORE = '1/20';
const ROUTE = { steps: [{ from: '1/1', to: STORE }], cost: 1, blocked: false } as unknown as Route;
const LEG: GearLeg = { steps: 3, fights: [], hazards: [], walls: [], needs: [], blocked: null };

const PLAN: GearTripPlan = {
  from: '1/1',
  stops: [
    {
      kind: 'bank',
      room: BANK,
      place: 'Bank Lobby',
      bank: 'Bank of Godfrey',
      shop: 8,
      held: 9000,
      withdraw: 2000,
      leg: LEG
    },
    {
      kind: 'shop',
      room: STORE,
      place: 'Armoury',
      shop: 'Armoury',
      items: [
        { item: 1, name: 'leather cap', replaces: null, charged: 900 },
        { item: 2, name: 'copper ring', replaces: 'brass ring', charged: 600 }
      ],
      leg: LEG
    }
  ],
  moves: 6,
  owed: 1500,
  unpriced: 0,
  purse: 0,
  short: 0,
  left: []
};

function carrying(...pack: string[]): CharacterState {
  const base = structuredClone(EMPTY_CHARACTER);
  return {
    ...base,
    phase: 'in-game',
    inventory: { ...base.inventory, listedAt: 1, items: pack.map((name) => wireItem(name)) }
  };
}

function banked(state: CharacterState, copper: number): CharacterState {
  return { ...state, banks: [{ shop: 8, name: 'Bank of Godfrey', copper, at: Date.now() + 1 }] };
}

let seq = 0;
function block(type: BlockType, groups: Record<string, string>): Block {
  seq += 1;
  return {
    seq,
    at: Date.now(),
    type,
    domain: domainOf(type),
    groups,
    text: '',
    terminator: 'newline',
    confidence: 0.8
  };
}

let sent: string[];
let notices: string[];
let decisions: SafetyDecision[];
let progress: Array<GearTripProgress | null>;
let queue: CommandQueue;
let here: string | null;
let current: CharacterState;
let log: string[];

const planner = (over: Partial<GearTripPlanner> = {}): GearTripPlanner => ({
  here: () => here,
  current: () => current,
  routeTo: (room) => {
    log.push(`route:${room}`);
    return ROUTE;
  },
  walk: (_route, run) => {
    log.push(run ? 'run' : 'walk');
    return null;
  },
  moveInFlight: () => false,
  walking: () => false,
  busy: () => false,
  escaping: () => false,
  looping: () => true,
  hold: () => void log.push('hold'),
  release: () => void log.push('release'),
  combatOffForRun: () => {
    log.push('combat off');
    return true;
  },
  combatOnAfterRun: () => void log.push('combat on'),
  wearCommands: (bought) => bought.map((buy) => `wear ${buy.name}`),
  ...over
});

beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  notices = [];
  decisions = [];
  progress = [];
  here = '1/1';
  current = carrying();
  log = [];
  queue = new CommandQueue(automation, { send: (command) => sent.push(command) });
});

afterEach(() => {
  queue.dispose();
  vi.useRealTimers();
});

const make = (over: Partial<GearTripPlanner> = {}, enabled = true): GearTrip =>
  new GearTrip(enabled, queue, planner(over), {
    notice: (m) => notices.push(m),
    decided: (d) => decisions.push(d),
    gearTrip: (p) => progress.push(p)
  });
const drain = (): void => void vi.advanceTimersByTime(500);
const arrive = (trip: GearTrip, room: string, state: CharacterState): void => {
  here = room;
  current = state;
  trip.onWalkEnded(true, null, state);
  drain();
};

describe('a gear trip', () => {
  it('draws at the vault, buys each item at the counter, then puts them on', () => {
    const trip = make();
    expect(trip.start(PLAN, false, current)).toBeNull();
    expect(log).toEqual(['hold', `route:${BANK}`, 'walk']);

    arrive(trip, BANK, carrying());
    expect(sent).toEqual(['bank']);
    expect(trip.progress?.stage).toBe('bank');
    trip.onCharacter(banked(carrying(), 9000));
    drain();
    expect(sent).toEqual(['bank', 'withdraw 2000']);
    // A withdrawal the player typed is not the vault paying this one.
    trip.onBlock(block('user-withdraws', { amount: '5' }));
    expect(trip.progress?.stage).toBe('bank');
    trip.onBlock(block('user-withdraws', { amount: '2000' }));
    expect(log.slice(-2)).toEqual([`route:${STORE}`, 'walk']);

    arrive(trip, STORE, carrying());
    expect(sent.at(-1)).toBe('buy leather cap');
    trip.onCharacter(carrying('leather cap'));
    drain();
    expect(sent.at(-1)).toBe('buy copper ring');
    current = carrying('leather cap', 'copper ring');
    trip.onCharacter(current);
    drain();

    expect(sent.slice(-2)).toEqual(['wear leather cap', 'wear copper ring']);
    expect(trip.busy).toBe(false);
    expect(log.at(-1)).toBe('release');
    expect(progress.at(-1)).toMatchObject({
      stage: 'ended',
      bought: ['leather cap', 'copper ring'],
      done: true
    });
    expect(notices.at(-1)).toBe(t('automation.gearTrip.done', { bought: 2, wanted: 2 }));
  });

  it('runs with auto-combat off and turns it on at the end; a run stopped short leaves it off', () => {
    const shopOnly: GearTripPlan = { ...PLAN, stops: [PLAN.stops[1]!] };
    const trip = make();
    trip.start(shopOnly, true, current);
    expect(log).toEqual(['combat off', 'hold', `route:${STORE}`, 'run']);
    arrive(trip, STORE, carrying());
    trip.onCharacter(carrying('leather cap'));
    drain();
    trip.onCharacter(carrying('leather cap', 'copper ring'));
    drain();
    expect(log).toContain('combat on');

    log = [];
    const stopped = make();
    stopped.start(shopOnly, true, carrying());
    stopped.stop();
    expect(log).not.toContain('combat on');
    expect(notices.at(-1)).toBe(
      t('automation.gearTrip.ended', { why: t('automation.gearTrip.stoppedByPlayer') })
    );
  });

  it('waits out a fight on the way and plans the leg again from where it ended', () => {
    const trip = make();
    trip.start(PLAN, false, current);
    const fighting = { ...carrying(), inCombat: true };
    trip.onWalkEnded(false, 'combat', fighting);
    expect(trip.busy).toBe(true);
    trip.onCharacter(fighting);
    expect(log.filter((entry) => entry.startsWith('route:'))).toHaveLength(1);
    trip.onCharacter(carrying());
    expect(log.filter((entry) => entry.startsWith('route:'))).toHaveLength(2);
  });

  it('goes on to the counters when a vault holds too little, and says so', () => {
    const trip = make();
    trip.start(PLAN, false, current);
    arrive(trip, BANK, carrying());
    trip.onCharacter(banked(carrying(), 0));
    expect(notices).toContain(
      t('automation.gearTrip.bankShort', { bank: 'Bank of Godfrey', held: (0).toLocaleString() })
    );
    expect(log.at(-2)).toBe(`route:${STORE}`);
  });

  it('says what the counter did not sell once the pack stays the same past the wait', () => {
    const shopOnly: GearTripPlan = { ...PLAN, stops: [PLAN.stops[1]!] };
    const trip = make();
    here = STORE;
    trip.start(shopOnly, false, carrying());
    drain();
    trip.onCharacter(carrying('leather cap'));
    drain();
    vi.advanceTimersByTime(tuning().gear.confirmMs);
    current = carrying('leather cap');
    trip.onCharacter(current);
    drain();
    expect(notices).toContain(t('automation.gearTrip.notSold', { items: 'copper ring' }));
    expect(sent).toContain('wear leather cap');
    expect(sent).not.toContain('wear copper ring');
  });

  it('refuses out loud while another trip runs, out of the realm, or switched off', () => {
    const busy = make();
    busy.start(PLAN, false, current);
    expect(busy.start(PLAN, false, current)).toBe(t('automation.hostTrip.refusalBusy'));
    expect(make().start(PLAN, false, EMPTY_CHARACTER)).toBe(
      t('automation.hostTrip.refusalNotInRealm')
    );
    expect(make({}, false).start(PLAN, false, current)).toBe(
      t('automation.hostTrip.refusalSwitchedOff')
    );
    expect(decisions.filter((d) => d.acted === false)).toHaveLength(3);
  });

  it('sets off from a rest; the walk decides whether to rest on the way', () => {
    const resting = structuredClone(current);
    resting.vitals = { ...resting.vitals, resting: true };
    expect(make().start(PLAN, false, resting)).toBeNull();
    expect(log).toContain('walk');
    log.length = 0;
    const meditating = structuredClone(current);
    meditating.vitals = { ...meditating.vitals, meditating: true };
    expect(make().start(PLAN, false, meditating)).toBeNull();
    expect(log).toContain('walk');
  });

  it('ends a walk that stops short for anything but a fight, and gives the lap back', () => {
    const trip = make();
    trip.start(PLAN, false, current);
    trip.onWalkEnded(false, 'a door is locked', carrying());
    expect(trip.busy).toBe(false);
    expect(log.at(-1)).toBe('release');
  });

  it('drops the trip on a death', () => {
    const trip = make();
    trip.start(PLAN, false, current);
    trip.abandon();
    expect(trip.busy).toBe(false);
    expect(notices.at(-1)).toBe(
      t('automation.gearTrip.ended', { why: t('automation.hostTrip.endedDied') })
    );
  });
});
