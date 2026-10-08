import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { t } from '../../app/i18n';
import { tuning } from '../../app/tuning';
import { CommandQueue } from '../CommandQueue';
import { OutgrownGear, type OutgrownPlanner } from '../OutgrownGear';
import type { SafetyDecision } from '../../../shared/automation';
import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';
import { DEFAULT_CONFIG, type AutomationConfig } from '../../../shared/config';
import type { ItemEntity } from '../../../shared/entities';
import type { OutgrownItem } from '../../../shared/outgrown';
import type { Rarity } from '../../../shared/rarity';
import type { SalePlace } from '../../../shared/selling';
import type { Route } from '../../../shared/world';

const automation: AutomationConfig = {
  ...DEFAULT_CONFIG.automation,
  pacing: { window: 8, minGapMs: 0, ackTimeoutMs: 1000 }
};
const ON = { enabled: true, ganghouseRoom: 'Silver House Vault 15/921' };

const entity = (name: string, over: Partial<ItemEntity> = {}): ItemEntity =>
  ({ name, source: 'wire', slot: null, equipped: false, charges: null, ...over }) as ItemEntity;

/** Soul's pack, 2026-10-01: cloth shoes worn, sandals carried, both 10 AC. */
function packed(...carried: ItemEntity[]): CharacterState {
  const base = structuredClone(EMPTY_CHARACTER);
  return {
    ...base,
    phase: 'in-game',
    room: { ...base.room, map: 1, number: 10 },
    inventory: {
      ...base.inventory,
      listedAt: 1,
      items: [entity('cloth shoes', { equipped: true }), ...carried]
    }
  };
}

const outgrown = (
  name: string,
  copper: number | null,
  over: Partial<ItemEntity> = {},
  rarity: Rarity = 'common'
) =>
  ({
    item: entity(name, { id: 7, ...over }),
    slot: 'Feet',
    worn: 'cloth shoes',
    copper,
    rarity
  }) as OutgrownItem;

const ROUTE = { steps: [{}, {}, {}], cost: 3, blocked: false } as unknown as Route;
const COUNTER: SalePlace = {
  shop: 'General Store',
  at: { map: 1, room: 20 },
  roomName: 'General Store',
  moves: 4,
  copper: 1_000
};

let sent: string[];
let notices: string[];
let decisions: SafetyDecision[];
let queue: CommandQueue;
let here: string | null;
let found: OutgrownItem[];
let walked: Route[];
let held: number;
let released: number;
let house: ReturnType<OutgrownPlanner['ganghouse']>;
let counter: SalePlace | null;
let busy: boolean;

const planner = (): OutgrownPlanner => ({
  here: () => here,
  outgrown: () => found,
  ganghouse: () => house,
  counterFor: () => counter,
  routeTo: () => ROUTE,
  walk: (route) => {
    walked.push(route);
    return null;
  },
  moveInFlight: () => false,
  walking: () => false,
  busy: () => busy,
  looping: () => true,
  hold: () => void (held += 1),
  release: () => void (released += 1)
});

const trip = (): OutgrownGear =>
  new OutgrownGear(ON, true, queue, planner(), {
    notice: (message) => notices.push(message),
    decided: (decision) => decisions.push(decision)
  });

beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  notices = [];
  decisions = [];
  walked = [];
  held = 0;
  released = 0;
  here = '1/10';
  found = [];
  house = { room: '15/921', name: 'Silver House Vault 15/921' };
  counter = COUNTER;
  busy = false;
  queue = new CommandQueue(automation, { send: (command) => sent.push(command) });
});

afterEach(() => {
  queue.dispose();
  vi.useRealTimers();
});

describe('getting rid of outgrown gear', () => {
  it('drops a cheap item where it stands, and the pack losing it is the confirmation', () => {
    const errand = trip();
    found = [outgrown('sandals', 200)];
    errand.onCharacter(packed(entity('sandals')));
    expect(sent).toEqual(['drop sandals']);
    expect(walked).toEqual([]);
    expect(errand.busy).toBe(true);
    errand.onCharacter(packed());
    expect(errand.busy).toBe(false);
    expect(notices).toContain(
      t('automation.outgrown.done', { item: 'sandals', verb: 'drop', worn: 'cloth shoes' })
    );
    expect(decisions.at(-1)).toMatchObject({ acted: true });
  });

  it('walks a valuable item to the ganghouse room, holding the lap, and hides it there', () => {
    const errand = trip();
    found = [outgrown('silver ring', 50_000)];
    errand.onCharacter(packed(entity('silver ring')));
    expect(walked).toHaveLength(1);
    expect(held).toBe(1);
    expect(sent).toEqual([]);
    here = '15/921';
    errand.onWalkEnded(true, null, packed(entity('silver ring')));
    expect(sent).toEqual(['hide silver ring']);
    errand.onCharacter(packed());
    expect(released).toBe(1);
  });

  it('sells instead where the ganghouse is not open, and says why once', () => {
    const errand = trip();
    house = { refused: t('automation.outgrown.noStashGangUnread') };
    found = [outgrown('silver ring', 50_000), outgrown('gold ring', 60_000, { id: 8 })];
    errand.onCharacter(packed(entity('silver ring'), entity('gold ring')));
    expect(walked).toHaveLength(1);
    expect(
      notices.filter((said) => said === t('automation.outgrown.noStashGangUnread'))
    ).toHaveLength(1);
    here = '1/20';
    errand.onWalkEnded(true, null, packed(entity('silver ring'), entity('gold ring')));
    expect(sent).toEqual(['sell silver ring']);
  });

  /* Todo 14: the game takes an unworn copy first, so a spare of the worn item goes. */
  it('drops a spare of the item worn', () => {
    const errand = trip();
    found = [outgrown('cloth shoes', 200)];
    errand.onCharacter(packed(entity('cloth shoes')));
    expect(sent).toEqual(['drop cloth shoes']);
  });

  it('keeps a rare item and one whose rarity is unknown, saying so once each', () => {
    const errand = trip();
    found = [outgrown('sandals', 200, {}, 'rare'), outgrown('slippers', 200, { id: 8 }, 'unknown')];
    const state = packed(entity('sandals'), entity('slippers'));
    errand.onCharacter(state);
    errand.onCharacter({ ...state, inventory: { ...state.inventory } });
    expect(sent).toEqual([]);
    expect(notices).toEqual([
      t('automation.outgrown.keptRare', { item: 'sandals' }),
      t('automation.outgrown.keptRarityUnknown', { item: 'slippers' })
    ]);
  });

  it('keeps an item with no one price, saying so', () => {
    const errand = trip();
    found = [outgrown('sandals', null)];
    errand.onCharacter(packed(entity('sandals')));
    expect(sent).toEqual([]);
    expect(notices).toEqual([
      t('automation.outgrown.keptUnpriced', { item: 'sandals', worn: 'cloth shoes' })
    ]);
  });

  it('takes a verb the pack does not confirm as refused, and tries the next way', () => {
    const errand = trip();
    found = [outgrown('sandals', 200)];
    errand.onCharacter(packed(entity('sandals')));
    expect(sent).toEqual(['drop sandals']);
    vi.advanceTimersByTime(tuning().outgrown.confirmMs);
    errand.onCharacter(packed(entity('sandals')));
    expect(decisions.at(-1)).toMatchObject({ acted: false });
    // Dropping refused, a counter that buys it is next.
    errand.onCharacter(packed(entity('sandals')));
    expect(walked).toHaveLength(1);
  });

  it('waits while anything else has the character, and goes once it lets go', () => {
    const errand = trip();
    found = [outgrown('sandals', 200)];
    busy = true;
    const state = packed(entity('sandals'));
    errand.onCharacter(state);
    errand.onCharacter({ ...state, inCombat: true });
    expect(sent).toEqual([]);
    busy = false;
    errand.onCharacter(state);
    expect(sent).toEqual(['drop sandals']);
  });

  it('does nothing while switched off', () => {
    const errand = new OutgrownGear({ ...ON, enabled: false }, true, queue, planner());
    found = [outgrown('sandals', 200)];
    errand.onCharacter(packed(entity('sandals')));
    expect(sent).toEqual([]);
    errand.configure(ON, true);
    errand.onCharacter(packed(entity('sandals')));
    expect(sent).toEqual(['drop sandals']);
  });

  it('sends nothing on arrival once switched off on the way, and gives the lap back', () => {
    const errand = trip();
    found = [outgrown('silver ring', 50_000)];
    errand.onCharacter(packed(entity('silver ring')));
    expect(walked).toHaveLength(1);
    errand.configure({ ...ON, enabled: false }, true);
    expect(released).toBe(1);
    expect(errand.busy).toBe(false);
    here = '15/921';
    errand.onWalkEnded(true, null, packed(entity('silver ring')));
    expect(sent).toEqual([]);
  });

  it('gives the lap back when a death ends the walk', () => {
    const errand = trip();
    found = [outgrown('silver ring', 50_000)];
    errand.onCharacter(packed(entity('silver ring')));
    errand.abandon();
    expect(released).toBe(1);
    expect(errand.busy).toBe(false);
  });
});
