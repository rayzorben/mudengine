import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CommandQueue } from '../CommandQueue';
import { t } from '../../app/i18n';
import { Supplies, type SupplyPlanner } from '../Supplies';
import { DEFAULT_CONFIG, type AutomationConfig, type SuppliesConfig } from '../../../shared/config';
import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';
import { domainOf, type Block, type BlockType } from '../../../shared/blocks';
import { wireItem } from '../../../shared/entities';
import type { SafetyDecision } from '../../../shared/automation';
import type { Route } from '../../../shared/world';
import { DEFAULT_INTERNAL } from '../../../shared/internal';

const TUNING = DEFAULT_INTERNAL.tuning;

const automation: AutomationConfig = {
  ...DEFAULT_CONFIG.automation,
  pacing: { window: 8, minGapMs: 0, ackTimeoutMs: 1000 }
};

const TORCHES: SuppliesConfig = {
  enabled: true,
  items: [{ name: 'torch', min: 3, max: 5, shop: 'General Store', at: { map: 1, room: 2147 } }]
};

const ROUTE: Route = {
  cost: 2,
  blocked: false,
  steps: [
    {
      from: '1/1',
      to: '1/2',
      direction: 'e',
      command: 'e',
      name: 'Main St',
      requirement: null,
      dark: false
    },
    {
      from: '1/2',
      to: '1/2147',
      direction: 'e',
      command: 'e',
      name: 'General Store',
      requirement: null,
      dark: false
    }
  ]
};

let seq = 0;
function block(type: BlockType, groups: Record<string, string> = {}): Block {
  seq += 1;
  return {
    seq,
    at: 1_700_000_000_000 + seq,
    type,
    domain: domainOf(type),
    groups,
    text: '',
    confidence: 0.8
  };
}

/** A character in the realm carrying `torches`, standing in `here`. */
function character(torches: number, over: Partial<CharacterState> = {}): CharacterState {
  const base = structuredClone(EMPTY_CHARACTER);
  return {
    ...base,
    phase: 'in-game',
    room: { ...base.room, map: 1, number: 1, name: 'Town Gates' },
    inventory: {
      ...base.inventory,
      items: Array.from({ length: torches }, () => wireItem('torch')),
      wealth: 5_000
    },
    ...over
  };
}

let sent: string[];
let notices: string[];
let decisions: SafetyDecision[];
let queue: CommandQueue;

beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  notices = [];
  decisions = [];
  queue = new CommandQueue(automation, { send: (command) => sent.push(command) });
});

afterEach(() => {
  queue.dispose();
  vi.useRealTimers();
});

/** A planner that records what was asked of it and answers as told. */
function planner(over: Partial<SupplyPlanner> = {}) {
  const log: string[] = [];
  let here = '1/1';
  const base: SupplyPlanner = {
    here: () => here,
    shopRoom: () => ({ room: '1/2147', name: 'General Store' }),
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
    hold: () => log.push('hold'),
    release: () => log.push('release'),
    ...over
  };
  return { planner: base, log, arrive: () => void (here = '1/2147') };
}

const make = (p: SupplyPlanner, config = TORCHES, enabled = true): Supplies =>
  new Supplies(config, enabled, queue, p, {
    notice: (m) => notices.push(m),
    decided: (d) => decisions.push(d)
  });
const drain = (): void => void vi.advanceTimersByTime(100);

/** The counter's answer to `list`, as the tracker would have kept it. */
function listed(state: CharacterState, price = '2 gold crowns'): CharacterState {
  return {
    ...state,
    shopListing: {
      at: Date.now() + 1,
      items: [{ name: 'torch', quantity: null, price, note: null }]
    }
  };
}

describe('noticing the pack is short', () => {
  it('holds the loop and walks to the shop, and says so', () => {
    const { planner: p, log } = planner();
    const auto = make(p);
    auto.onCharacter(character(2));
    expect(log).toEqual(['hold', 'route:1/2147', 'walk']);
    expect(notices[0]).toContain('General Store');
    expect(decisions[0]).toMatchObject({ action: 'supplies', acted: true });
    expect(auto.current?.stage).toBe('walking');
  });

  it('does nothing while enough is carried', () => {
    const { planner: p, log } = planner();
    make(p).onCharacter(character(3));
    expect(log).toEqual([]);
  });

  it('does nothing until the pack has been read', () => {
    const { planner: p, log } = planner();
    const unread = character(0);
    make(p).onCharacter({ ...unread, inventory: { ...unread.inventory, wealth: null } });
    expect(log).toEqual([]);
  });

  it('yields to a fight, a rest, an unanswered move, another walk and an escape', () => {
    const short = character(1);
    expect(
      (() => {
        const { planner: p, log } = planner();
        make(p).onCharacter({ ...short, inCombat: true });
        return log;
      })()
    ).toEqual([]);
    expect(
      (() => {
        const { planner: p, log } = planner();
        make(p).onCharacter({ ...short, vitals: { ...short.vitals, resting: true } });
        return log;
      })()
    ).toEqual([]);
    expect(
      (() => {
        const { planner: p, log } = planner({ moveInFlight: () => true });
        make(p).onCharacter(short);
        return log;
      })()
    ).toEqual([]);
    expect(
      (() => {
        const { planner: p, log } = planner({ walking: () => true });
        make(p).onCharacter(short);
        return log;
      })()
    ).toEqual([]);
    expect(
      (() => {
        const { planner: p, log } = planner({ busy: () => true });
        make(p).onCharacter(short);
        return log;
      })()
    ).toEqual([]);
  });

  it('refuses out loud when the shop cannot be settled, and leaves the item alone for a while', () => {
    const { planner: p, log } = planner({ shopRoom: () => 'six rooms are called General Store' });
    const auto = make(p);
    auto.onCharacter(character(1));
    auto.onCharacter(character(1));
    expect(log).toEqual([]);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ acted: false });
    expect(decisions[0]?.refused).toContain('six rooms');
    vi.advanceTimersByTime(TUNING.supplies.retryMs + 1);
    auto.onCharacter(character(1));
    expect(decisions).toHaveLength(2);
  });

  it('is a setting, and off it does nothing', () => {
    const { planner: p, log } = planner();
    make(p, { ...TORCHES, enabled: false }).onCharacter(character(1));
    make(p, TORCHES, false).onCharacter(character(1));
    expect(log).toEqual([]);
  });
});

describe('at the counter', () => {
  it('asks the counter, buys one at a time on each confirmation, and lets the loop go', () => {
    const { planner: p, log, arrive } = planner();
    const auto = make(p);
    auto.onCharacter(character(2));
    arrive();
    auto.onWalkEnded(true, null, character(2));
    drain();
    expect(sent).toEqual(['list']);
    expect(auto.current?.stage).toBe('listing');

    auto.onCharacter(listed(character(2)));
    drain();
    expect(sent).toEqual(['list', 'buy torch']);

    auto.onBlock(block('user-buys', { item: 'torch', price: '400' }), character(3));
    drain();
    expect(sent).toEqual(['list', 'buy torch', 'buy torch']);
    auto.onBlock(block('user-buys', { item: 'torch', price: '400' }), character(4));
    drain();
    expect(sent).toEqual(['list', 'buy torch', 'buy torch', 'buy torch']);

    auto.onBlock(block('user-buys', { item: 'torch', price: '400' }), character(5));
    drain();
    expect(sent).toHaveLength(4);
    expect(auto.current).toBeNull();
    expect(log.at(-1)).toBe('release');
    expect(notices.at(-1)).toContain('Bought 3 torch');
  });

  it('buys straight away when already standing in the shop', () => {
    const { planner: p, log, arrive } = planner();
    arrive();
    const auto = make(p);
    auto.onCharacter(character(2));
    drain();
    expect(log).toEqual(['hold']);
    expect(sent).toEqual(['list']);
  });

  it('refuses when the counter does not list the item', () => {
    const { planner: p, log, arrive } = planner();
    const auto = make(p);
    auto.onCharacter(character(2));
    arrive();
    auto.onWalkEnded(true, null, character(2));
    const state = character(2);
    auto.onCharacter({
      ...state,
      shopListing: {
        at: Date.now() + 1,
        items: [{ name: 'lantern', quantity: null, price: '2 gold crowns', note: null }]
      }
    });
    drain();
    expect(sent).toEqual(['list']);
    expect(log.at(-1)).toBe('release');
    expect(decisions.at(-1)?.refused).toContain('does not list torch');
  });

  it('refuses when the quote is more than the purse holds', () => {
    const { planner: p, arrive } = planner();
    const auto = make(p);
    auto.onCharacter(character(2));
    arrive();
    auto.onWalkEnded(true, null, character(2));
    auto.onCharacter(listed(character(2), '90 gold crowns'));
    drain();
    expect(sent).toEqual(['list']);
    expect(decisions.at(-1)?.refused).toContain('9,000 copper');
  });

  it('takes a buy the counter never confirms as refused, and says so', () => {
    const { planner: p, log, arrive } = planner();
    const auto = make(p);
    auto.onCharacter(character(2));
    arrive();
    auto.onWalkEnded(true, null, character(2));
    auto.onCharacter(listed(character(2)));
    drain();
    expect(sent).toEqual(['list', 'buy torch']);
    vi.advanceTimersByTime(TUNING.supplies.buyTimeoutMs + 1);
    expect(auto.current).toBeNull();
    expect(log.at(-1)).toBe('release');
    expect(decisions.at(-1)?.refused).toContain('did not confirm');
  });
});

describe('on the way', () => {
  it('waits out a fight that stopped the walk and plans again after it', () => {
    const { planner: p, log } = planner();
    const auto = make(p);
    auto.onCharacter(character(2));
    auto.onWalkEnded(false, 'a fight started', character(2, { inCombat: true }));
    expect(auto.current?.stage).toBe('waiting');
    auto.onCharacter(character(2, { inCombat: true }));
    expect(log.filter((entry) => entry === 'walk')).toHaveLength(1);
    auto.onCharacter(character(2));
    expect(log.filter((entry) => entry === 'walk')).toHaveLength(2);
    expect(auto.current?.stage).toBe('walking');
  });

  it('gives up after enough legs, out loud', () => {
    const { planner: p, log } = planner();
    const auto = make(p);
    auto.onCharacter(character(2));
    for (let leg = 0; leg < TUNING.supplies.maxLegs; leg += 1) {
      auto.onWalkEnded(false, 'a shut door', character(2));
    }
    expect(auto.current).toBeNull();
    expect(log.at(-1)).toBe('release');
    expect(decisions.at(-1)?.refused).toContain('could not reach');
  });

  it('is abandoned by a death, and the loop let go', () => {
    const { planner: p, log } = planner();
    const auto = make(p);
    auto.onCharacter(character(2));
    auto.abandon('the character died');
    expect(auto.current).toBeNull();
    expect(log.at(-1)).toBe('release');
  });
});

describe('yielding to the person at the keyboard', () => {
  /*
   * Found by review. `Walker.stop` raises `ended` for a typed direction
   * exactly as it does for a shut door, so the errand booked it as a failed
   * leg, replanned from wherever the player had just walked to, and marched
   * them back — four times over before it gave up.
   */
  it('gives the errand up when the player moves the character', () => {
    const { planner: p, log } = planner();
    const auto = make(p);
    auto.onCharacter(character(2));
    expect(auto.current).not.toBeNull();

    auto.notePlayerMoved();
    expect(auto.current).toBeNull();
    expect(log.at(-1)).toBe('release');

    // And it does not quietly start again on the next status line.
    auto.onCharacter(character(2));
    expect(auto.current).toBeNull();
  });

  it('gives it up when the player presses Stop', () => {
    const { planner: p, log } = planner();
    const auto = make(p);
    auto.onCharacter(character(2));
    auto.onWalkEnded(false, t('session.walk.stoppedByPlayer'), character(2));
    expect(auto.current).toBeNull();
    expect(log.at(-1)).toBe('release');
  });

  /* An escape outranks shopping on a replanned leg, not only on a fresh one. */
  it('does not replan a leg while an escape is in flight', () => {
    let escaping = false;
    const { planner: p, log } = planner({ busy: () => escaping });
    const auto = make(p);
    auto.onCharacter(character(2));
    escaping = true;
    auto.onWalkEnded(false, 'a shut door', character(2));
    expect(auto.current).toBeNull();
    expect(log.at(-1)).toBe('release');
  });

  /*
   * `Walker.start` raises no ending when it *replaces* a running walk, so an
   * errand whose leg is superseded has nothing to wake it. The deadline is
   * what stops it holding the lap for the rest of the session.
   */
  it('gives the lap back when the errand has hung', () => {
    const { planner: p, log } = planner();
    const auto = make(p);
    auto.onCharacter(character(2));
    expect(auto.current).not.toBeNull();
    vi.advanceTimersByTime(TUNING.supplies.errandTimeoutMs + 1000);
    expect(auto.current).toBeNull();
    expect(log.at(-1)).toBe('release');
  });
});
