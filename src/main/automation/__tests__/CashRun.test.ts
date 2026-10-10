import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { t } from '../../app/i18n';
import { tuning } from '../../app/tuning';
import { CashRun, type CashRunPlanner } from '../CashRun';
import { CommandQueue } from '../CommandQueue';
import { domainOf, type Block, type BlockType } from '../../../shared/blocks';
import type { CashRunAsk, CashRunToken } from '../../../shared/cashRun';
import {
  EMPTY_CHARACTER,
  NO_COINS,
  type CharacterState,
  type Coins
} from '../../../shared/character';
import { DEFAULT_CONFIG, type AutomationConfig } from '../../../shared/config';
import type { Route } from '../../../shared/world';

const automation: AutomationConfig = {
  ...DEFAULT_CONFIG.automation,
  pacing: { window: 8, minGapMs: 0, ackTimeoutMs: 1000 }
};
const LOOP_ROOM = '15/1055';
const LANDING = '1/1813';
const BANK = '1/297';
const ROUTE = { steps: [{ from: LANDING, to: BANK }], cost: 1, blocked: false } as unknown as Route;
const SILVERMERE: CashRunToken = {
  item: 3381,
  name: 'token of Silvermere',
  lands: 'Pier',
  fare: 200_000
};
const RHUDAUR: CashRunToken = {
  item: 3385,
  name: 'token of Rhudaur',
  lands: 'Rhudaur, Massive Doors',
  fare: 200_000
};
const ASK: CashRunAsk = {
  loop: 'Lava Fields: Crimson Fort Loop',
  coins: ['platinum', 'gold'],
  tokens: [SILVERMERE.item, RHUDAUR.item],
  full: 'heavy'
};

function character(wealth: number, coins: Partial<Coins> = {}, word = 'Light'): CharacterState {
  const base = structuredClone(EMPTY_CHARACTER);
  return {
    ...base,
    phase: 'in-game',
    inventory: {
      ...base.inventory,
      wealth,
      coins: { ...NO_COINS, copper: 0, silver: 0, gold: 0, platinum: 0, runic: 0, ...coins },
      encumbranceWord: word
    }
  };
}

function withMonster(state: CharacterState): CharacterState {
  return {
    ...state,
    room: { ...state.room, occupants: [{ name: 'big orc rogue', kind: 'mob' } as never] }
  };
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
let log: string[];
let here: string | null;
let current: CharacterState;
let looping: boolean;
let queue: CommandQueue;

const planner = (over: Partial<CashRunPlanner> = {}): CashRunPlanner => ({
  here: () => here as never,
  current: () => current,
  startLoop: (name) => {
    log.push(`loop:${name}`);
    looping = true;
    return null;
  },
  looping: () => looping,
  hold: () => void log.push('hold'),
  release: () => void log.push('release'),
  routeTo: (room) => {
    log.push(`route:${room}`);
    return ROUTE;
  },
  walk: () => {
    log.push('walk');
    return null;
  },
  moveInFlight: () => false,
  escaping: () => false,
  tokens: () => [SILVERMERE, RHUDAUR],
  nearestBank: () => ({ room: BANK as never, name: 'Bank of Godfrey' }),
  collectCoins: (kinds, until) => void log.push(`collect:${kinds.join(',')}:${until}`),
  collectAsConfigured: () => void log.push('collect as configured'),
  dropCoins: (counts) => {
    log.push(`drop:${[...counts].map(([coin, count]) => `${count} ${coin}`).join(',')}`);
    return [];
  },
  deposit: (keep) => {
    log.push(`deposit keeping ${keep}`);
    return true;
  },
  ...over
});

beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  notices = [];
  log = [];
  here = LOOP_ROOM;
  looping = false;
  current = character(50_000, { platinum: 5 });
  queue = new CommandQueue(automation, { send: (command) => sent.push(command) });
});

afterEach(() => {
  queue.dispose();
  vi.useRealTimers();
});

const make = (over: Partial<CashRunPlanner> = {}): CashRun =>
  new CashRun(true, queue, planner(over), { notice: (message) => notices.push(message) });
const drain = (): void => void vi.advanceTimersByTime(200);
/** The look answering, after the prompt that credits the queue. */
const answer = (run: CashRun, uses: number): void => {
  drain();
  run.onBlock(block('item-uses-left', { uses: String(uses) }));
  drain();
};
const started = (run: CashRun, uses: [number, number] = [2, 5]): void => {
  expect(run.start(ASK, current)).toBeNull();
  answer(run, uses[0]);
  answer(run, uses[1]);
};

describe('a cash run', () => {
  it('starts the loop, lays the coins and looks at each token once', () => {
    const run = make();
    started(run);
    expect(log).toEqual([`loop:${ASK.loop}`, 'collect:platinum,gold:heavy']);
    expect(sent).toEqual(['look token of Silvermere', 'look token of Rhudaur']);
    expect(
      notices.some(
        (n) => n === t('automation.cashRun.usesLeft.many', { token: SILVERMERE.name, uses: 2 })
      )
    ).toBe(true);
  });

  it('when full in an empty room, uses the token, banks what was gained and gives the lap back', () => {
    const run = make();
    started(run);
    current = character(350_000, { platinum: 35 }, 'Heavy');
    run.onCharacter(current);
    drain();
    expect(log).toContain('hold');
    expect(sent.at(-1)).toBe('look token of Silvermere');
    answer(run, 2);
    expect(sent.at(-1)).toBe('use token of Silvermere');

    // The token's script moves the character to the Pier.
    here = LANDING;
    current = character(150_000, { platinum: 15 }, 'Light');
    run.onCharacter(current);
    expect(log.slice(-2)).toEqual([`route:${BANK}`, 'walk']);

    here = BANK;
    run.onWalkEnded(true, null, current);
    // Keeping back the cash on hand when the run started.
    expect(log.at(-1)).toBe('deposit keeping 50000');
    run.onBlock(block('user-deposits', { amount: '100000' }));
    expect(log.at(-1)).toBe('release');
    expect(run.running).toBe(true);
  });

  it('passes over a token with no uses left for the next one', () => {
    const run = make();
    started(run, [0, 5]);
    current = character(350_000, { platinum: 35 }, 'Heavy');
    run.onCharacter(current);
    drain();
    expect(sent.at(-1)).toBe('look token of Rhudaur');
    answer(run, 5);
    expect(sent.at(-1)).toBe('use token of Rhudaur');
  });

  it('drops what was collected and ends when it is less than the fare', () => {
    const run = make();
    started(run);
    current = character(150_000, { platinum: 10, gold: 50 }, 'Heavy');
    run.onCharacter(current);
    expect(log).toContain('drop:5 platinum,50 gold');
    // Held until the coins are on this room's floor, or they would land in the next.
    expect(log).not.toContain('release');
    expect(run.running).toBe(true);
    current = character(50_000, { platinum: 5, gold: 0 }, 'Light');
    run.onCharacter(current);
    expect(log.slice(-2)).toEqual(['collect as configured', 'release']);
    expect(run.running).toBe(false);
    expect(sent.some((command) => command.startsWith('use '))).toBe(false);
  });

  it('waits for the room to clear, and walks on when its monsters stay', () => {
    const run = make();
    started(run);
    current = withMonster(character(350_000, { platinum: 35 }, 'Heavy'));
    run.onCharacter(current);
    expect(log).toContain('hold');
    vi.advanceTimersByTime(tuning().cashRun.clearMs + 1);
    run.onCharacter(current);
    expect(log.at(-1)).toBe('release');
    expect(sent.some((command) => command.startsWith('use '))).toBe(false);
    // The same room is not tried again; the next one is.
    run.onCharacter(current);
    expect(log.filter((entry) => entry === 'hold')).toHaveLength(1);
    here = '15/1064';
    current = character(350_000, { platinum: 35 }, 'Heavy');
    run.onCharacter(current);
    drain();
    expect(sent.at(-1)).toBe('look token of Silvermere');
  });

  it('never takes a late answer to a look given up on for the next one', () => {
    const run = make();
    expect(run.start(ASK, current)).toBeNull();
    drain();
    // The first look goes unanswered past its wait, and the second goes out.
    vi.advanceTimersByTime(tuning().cashRun.lookMs + 1);
    drain();
    expect(sent).toEqual(['look token of Silvermere', 'look token of Rhudaur']);
    // The first answer arrives late: it is Silvermere's, not Rhudaur's.
    run.onBlock(block('item-uses-left', { uses: '0' }));
    expect(run.running).toBe(true);
    run.onBlock(block('item-uses-left', { uses: '5' }));
    expect(notices.at(-1)).toBe(
      t('automation.cashRun.usesLeft.many', { token: RHUDAUR.name, uses: 5 })
    );
  });

  it('ends, and the loop goes on, when every token is used up', () => {
    const run = make();
    started(run, [0, 0]);
    expect(run.running).toBe(false);
    expect(log.at(-1)).toBe('collect as configured');
  });

  it('ends when the loop stops', () => {
    const run = make();
    started(run);
    looping = false;
    run.onCharacter(current);
    expect(run.running).toBe(false);
  });

  it('refuses an unread purse, and tokens the character does not carry', () => {
    const run = make({ tokens: () => [] });
    expect(run.start(ASK, current)).toBe(t('automation.cashRun.refusalNoToken'));
    const unread = { ...current, inventory: { ...current.inventory, wealth: null } };
    expect(make().start(ASK, unread)).toBe(t('automation.cashRun.refusalPurseUnread'));
    expect(log).toEqual([]);
  });
});
