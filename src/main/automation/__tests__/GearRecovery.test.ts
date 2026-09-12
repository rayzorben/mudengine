import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GearRecovery, type RecoveryPlanner } from '../GearRecovery';
import { CommandQueue } from '../CommandQueue';
import { DEFAULT_CONFIG, type AutomationConfig, type MovementConfig } from '../../../shared/config';
import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';
import type { SafetyDecision } from '../../../shared/automation';
import type { Route } from '../../../shared/world';
import { wireItem } from '../../../shared/entities';

const automation: AutomationConfig = {
  ...DEFAULT_CONFIG.automation,
  pacing: { window: 8, minGapMs: 0, ackTimeoutMs: 1000 }
};

const movement = (over: Partial<MovementConfig> = {}): MovementConfig => ({
  ...DEFAULT_CONFIG.automation.movement,
  recoverGear: true,
  ...over
});

const DIED_AT = 1_000_000;
const LOADOUT = [
  { slot: 'Weapon Hand', item: 'ice crystal falchion', at: 1 },
  { slot: 'Back', item: 'crimson cloak', at: 1 },
  { slot: 'Finger', item: 'white gold ring', at: 1 }
];

/** In the temple after the death, the pack read since, wearing nothing but a ring. */
function stripped(over: Partial<CharacterState> = {}): CharacterState {
  const base = structuredClone(EMPTY_CHARACTER);
  return {
    ...base,
    phase: 'in-game',
    room: { ...base.room, map: 1, number: 100, name: 'Temple, Halls of the Dead' },
    loadout: LOADOUT,
    lastDeath: { map: 8, number: 915, name: 'Ancient Stronghold, Stable', at: DIED_AT },
    inventory: {
      ...base.inventory,
      listedAt: DIED_AT + 5000,
      items: [{ ...wireItem('white gold ring'), equipped: true, slot: 'Finger' }]
    },
    progress: { ...base.progress, armourClass: 0 },
    ...over
  };
}

/** Standing where it died, the kit on the floor. */
function atTheStable(over: Partial<CharacterState> = {}): CharacterState {
  const base = stripped();
  return {
    ...base,
    room: {
      ...base.room,
      map: 8,
      number: 915,
      name: 'Ancient Stronghold, Stable',
      items: [wireItem('ice crystal falchion'), wireItem('crimson cloak')],
      cash: { runic: 0, platinum: 0, gold: 39, silver: 72, copper: 4, totalCopper: 0 }
    },
    ...over
  };
}

const ROUTE: Route = {
  steps: [{ from: '1/100', to: '8/915' }] as unknown as Route['steps'],
  cost: 1,
  blocked: false
} as Route;

let sent: string[];
let notices: string[];
let decisions: SafetyDecision[];
let queue: CommandQueue;
let here: string | null;
let walked: Route[];

const planner = (over: Partial<RecoveryPlanner> = {}): RecoveryPlanner => ({
  here: () => here,
  routeTo: () => ROUTE,
  walk: (route) => {
    walked.push(route);
    return null;
  },
  moveInFlight: () => false,
  walking: () => false,
  busy: () => false,
  ...over
});

beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  notices = [];
  decisions = [];
  walked = [];
  here = '1/100';
  queue = new CommandQueue(automation, { send: (command) => sent.push(command) });
});

afterEach(() => {
  queue.dispose();
  vi.useRealTimers();
});

const make = (
  config = movement(),
  over: Partial<RecoveryPlanner> = {},
  enabled = true
): GearRecovery =>
  new GearRecovery(config, enabled, queue, planner(over), {
    notice: (m) => notices.push(m),
    decided: (d) => decisions.push(d)
  });
const drain = (): void => void vi.advanceTimersByTime(500);

describe('noticing the strip', () => {
  it('walks back to where the character died once the pack read since says the kit is gone', () => {
    make().onCharacter(stripped());
    expect(walked).toHaveLength(1);
    expect(notices[0]).toMatch(/Going back to Ancient Stronghold, Stable/);
    expect(notices[0]).toMatch(/2 remembered items/);
  });

  it('waits for a pack listing taken after the death, and for the sheet', () => {
    const auto = make();
    const s = stripped();
    auto.onCharacter({ ...s, inventory: { ...s.inventory, listedAt: DIED_AT - 1 } });
    auto.onCharacter({ ...s, progress: { ...s.progress, armourClass: null } });
    expect(walked).toEqual([]);
  });

  /* Either signal alone has an innocent reading. */
  it('does nothing for a character still wearing armour, or whose kit is in the pack', () => {
    const s = stripped();
    make().onCharacter({ ...s, progress: { ...s.progress, armourClass: 9 } });
    make().onCharacter({
      ...s,
      inventory: {
        ...s.inventory,
        items: LOADOUT.map((worn) => ({ ...wireItem(worn.item), equipped: false }))
      }
    });
    expect(walked).toEqual([]);
    expect(notices).toEqual([]);
  });

  it('is off by default, and one death is one attempt', () => {
    make(movement({ recoverGear: false })).onCharacter(stripped());
    expect(walked).toEqual([]);
    const auto = make();
    auto.onCharacter(stripped());
    auto.onCharacter(stripped());
    expect(walked).toHaveLength(1);
  });

  it('refuses out loud when there is no route back, and when the death was unplaced', () => {
    make(movement(), { routeTo: () => 'no way' }).onCharacter(stripped());
    make().onCharacter(
      stripped({ lastDeath: { map: null, number: null, name: null, at: DIED_AT } })
    );
    expect(decisions.map((d) => d.acted)).toEqual([false, false]);
    expect(decisions[0]?.refused).toMatch(/no route back/);
    expect(decisions[1]?.refused).toMatch(/does not know where/);
    expect(walked).toEqual([]);
  });

  it('yields to a move in flight, a walk, an escape', () => {
    make(movement(), { moveInFlight: () => true }).onCharacter(stripped());
    make(movement(), { walking: () => true }).onCharacter(stripped());
    make(movement(), { busy: () => true }).onCharacter(stripped());
    expect(walked).toEqual([]);
  });
});

describe('standing where it died', () => {
  it('takes the kit the floor lists and the coins, then dresses once the pack has them', () => {
    const auto = make();
    auto.onCharacter(stripped());
    here = '8/915';
    auto.onWalkEnded(true, null, atTheStable());
    drain();
    expect(sent).toEqual([
      'get ice crystal falchion',
      'get crimson cloak',
      'get gold',
      'get silver',
      'get copper'
    ]);
    expect(notices.at(-1)).toMatch(/Taking 2 from the floor/);
    // The ring was worn all along, so nothing of the kit is missing from the floor.
    expect(notices.at(-1)).not.toMatch(/not on this floor/);

    // The pack now holds them (maintained by `You took`), and the dressing follows.
    const dressed = atTheStable();
    auto.onCharacter({
      ...dressed,
      inventory: {
        ...dressed.inventory,
        items: [
          ...dressed.inventory.items,
          wireItem('ice crystal falchion'),
          wireItem('crimson cloak')
        ]
      }
    });
    drain();
    expect(sent.slice(5)).toEqual(['wear ice crystal falchion', 'wear crimson cloak']);
    expect(decisions.at(-1)).toMatchObject({ action: 'recover gear', acted: true });
  });

  it('dresses with what arrived once the pack has had its time, and says what did not', () => {
    const auto = make();
    auto.onCharacter(stripped());
    here = '8/915';
    auto.onWalkEnded(true, null, atTheStable());
    drain();
    const partly = atTheStable();
    const withOne = {
      ...partly,
      inventory: {
        ...partly.inventory,
        items: [...partly.inventory.items, wireItem('crimson cloak')]
      }
    };
    auto.onCharacter(withOne);
    expect(sent.some((c) => c.startsWith('wear'))).toBe(false);
    vi.advanceTimersByTime(9000);
    auto.onCharacter(withOne);
    drain();
    expect(sent.filter((c) => c.startsWith('wear'))).toEqual(['wear crimson cloak']);
    expect(notices.at(-1)).toMatch(/1 asked for and not taken/);
  });

  it('refuses out loud when nothing of the kit is on the floor', () => {
    const auto = make();
    auto.onCharacter(stripped());
    here = '8/915';
    auto.onWalkEnded(true, null, atTheStable({ room: { ...atTheStable().room, items: [] } }));
    drain();
    expect(sent).toEqual([]);
    expect(decisions.at(-1)).toMatchObject({ action: 'recover gear', acted: false });
    expect(decisions.at(-1)?.refused).toMatch(/nothing of the kit/);
  });

  it('refuses out loud when the walk back ended somewhere else', () => {
    const auto = make();
    auto.onCharacter(stripped());
    here = '1/101';
    auto.onWalkEnded(false, 'a fight', stripped());
    expect(decisions.at(-1)?.refused).toMatch(/ended early: a fight/);
    expect(sent).toEqual([]);
  });
});
