import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { t } from '../../app/i18n';
import { tuning } from '../../app/tuning';
import { CommandQueue } from '../CommandQueue';
import { asSellAsk, SellTrip, type SellTripPlanner } from '../SellTrip';
import type { SafetyDecision } from '../../../shared/automation';
import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';
import { DEFAULT_CONFIG, type AutomationConfig } from '../../../shared/config';
import { wireItem } from '../../../shared/entities';
import type { Route } from '../../../shared/world';

const automation: AutomationConfig = {
  ...DEFAULT_CONFIG.automation,
  pacing: { window: 8, minGapMs: 0, ackTimeoutMs: 1000 }
};
const STORE = '1/20';
const ROUTE = {
  steps: [{ from: '1/1', to: STORE }] as unknown as Route['steps'],
  cost: 1,
  blocked: false
} as Route;

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
let queue: CommandQueue;
let here: string | null;
let held: number;
let released: number;

const planner = (over: Partial<SellTripPlanner> = {}): SellTripPlanner => ({
  here: () => here,
  routeTo: () => ROUTE,
  walk: () => null,
  counterIn: (room) => (room === STORE ? 'General Store' : null),
  moveInFlight: () => false,
  walking: () => false,
  busy: () => false,
  looping: () => true,
  hold: () => void (held += 1),
  release: () => void (released += 1),
  ...over
});

beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  notices = [];
  decisions = [];
  here = '1/1';
  held = 0;
  released = 0;
  queue = new CommandQueue(automation, { send: (command) => sent.push(command) });
});

afterEach(() => {
  queue.dispose();
  vi.useRealTimers();
});

const make = (over: Partial<SellTripPlanner> = {}, enabled = true): SellTrip =>
  new SellTrip(enabled, queue, planner(over), {
    notice: (m) => notices.push(m),
    decided: (d) => decisions.push(d)
  });
const drain = (): void => void vi.advanceTimersByTime(500);

describe('selling at a counter for an extension', () => {
  it('walks to the counter holding the lap, sells each item in turn, and says what sold', () => {
    const trip = make();
    const ask = { room: STORE, items: ['silk robe', 'rope'] };
    expect(trip.sell(ask, carrying('silk robe', 'rope'))).toBeNull();
    expect(held).toBe(1);
    expect(trip.current).toEqual({
      room: STORE,
      shop: 'General Store',
      items: ['silk robe', 'rope'],
      stage: 'walking'
    });

    here = STORE;
    trip.onWalkEnded(true, null, carrying('silk robe', 'rope'));
    drain();
    expect(sent).toEqual(['sell silk robe']);
    expect(trip.current?.stage).toBe('selling');
    // The pack losing it is the confirmation; the next item's verb goes then.
    trip.onCharacter(carrying('rope'));
    drain();
    expect(sent).toEqual(['sell silk robe', 'sell rope']);
    trip.onCharacter(carrying());

    expect(trip.busy).toBe(false);
    expect(released).toBe(1);
    expect(notices.at(-1)).toBe(
      t('automation.sellTrip.done', { items: 'silk robe, rope', shop: 'General Store' })
    );
    expect(decisions.at(-1)).toMatchObject({ action: 'sell', acted: true });
  });

  it('says what the counter did not take once the pack stays the same past the wait', () => {
    const trip = make();
    here = STORE;
    trip.sell({ room: STORE, items: ['silk robe', 'rope'] }, carrying('silk robe', 'rope'));
    drain();
    trip.onCharacter(carrying('rope'));
    drain();
    vi.advanceTimersByTime(tuning().outgrown.confirmMs);
    trip.onCharacter(carrying('rope'));

    expect(trip.busy).toBe(false);
    expect(notices).toContain(
      t('automation.sellTrip.refused', {
        why: t('automation.sellTrip.endedUnsold', { items: 'rope' })
      })
    );
    expect(decisions.map((d) => d.acted)).toEqual([true, false]);
  });

  it('refuses out loud with no shop in the room, while fighting, or already on a trip', () => {
    expect(make().sell({ room: '1/99', items: ['rope'] }, carrying('rope'))).toBe(
      t('automation.sellTrip.refusalNoCounter', { room: '1/99' })
    );
    const fighting = { ...carrying('rope'), inCombat: true };
    expect(make().sell({ room: STORE, items: ['rope'] }, fighting)).toBe(
      t('automation.hostTrip.refusalFighting')
    );
    const busy = make();
    busy.sell({ room: STORE, items: ['rope'] }, carrying('rope'));
    expect(busy.sell({ room: STORE, items: ['rope'] }, carrying('rope'))).toBe(
      t('automation.hostTrip.refusalBusy')
    );
    expect(decisions.every((d) => d.acted === false)).toBe(true);
  });

  it('ends a walk that stops short, and gives the lap back', () => {
    const trip = make();
    trip.sell({ room: STORE, items: ['rope'] }, carrying('rope'));
    trip.onWalkEnded(false, 'a door is locked', carrying('rope'));
    expect(trip.busy).toBe(false);
    expect(released).toBe(1);
    expect(sent).toEqual([]);
    expect(notices.at(-1)).toBe(
      t('automation.sellTrip.refused', {
        why: t('automation.hostTrip.endedNotReached', { why: 'a door is locked' })
      })
    );
  });

  it('is dropped by a death, and the lap goes back', () => {
    const trip = make();
    trip.sell({ room: STORE, items: ['rope'] }, carrying('rope'));
    trip.abandon();
    expect(trip.busy).toBe(false);
    expect(released).toBe(1);
  });
});

describe("an extension's sale", () => {
  it('is read only when the room is map/room and every item a name, a name twice once', () => {
    expect(asSellAsk({ room: '1/20', items: ['rope', 'rope ', 'silk robe'] })).toEqual({
      room: STORE,
      items: ['rope', 'silk robe']
    });
    expect(asSellAsk({ room: 'the store', items: ['rope'] })).toBeNull();
    expect(asSellAsk({ room: '1/20', items: ['rope', 3] })).toBeNull();
    expect(asSellAsk(undefined)).toBeNull();
  });
});
