import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CommandQueue } from '../CommandQueue';
import { t } from '../../app/i18n';
import { Supplies, type SupplyPlanner } from '../Supplies';
import { DEFAULT_CONFIG, type AutomationConfig, type SuppliesConfig } from '../../../shared/config';
import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';
import { domainOf, type Block, type BlockType } from '../../../shared/blocks';
import { wireItem } from '../../../shared/entities';
import type { SafetyDecision } from '../../../shared/automation';
import type { CashPlace, Route } from '../../../shared/world';
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
    terminator: 'newline',
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
    priceAt: () => null,
    cashFrom: () => [],
    walk: () => {
      log.push('walk');
      return null;
    },
    moveInFlight: () => false,
    walking: () => false,
    busy: () => false,
    /*
     * A lap is running unless a test says otherwise: an errand only ever
     * starts itself from one, and these tests are about what it does once it
     * has. The gate itself is asserted below.
     */
    looping: () => true,
    hold: () => log.push('hold'),
    release: () => log.push('release'),
    ...over
  };
  return {
    planner: base,
    log,
    arrive: () => void (here = '1/2147'),
    goTo: (room: string) => void (here = room)
  };
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

  it('refuses when the quote is more than the purse holds and no bank holds the rest', () => {
    const { planner: p, arrive } = planner();
    const auto = make(p);
    auto.onCharacter(character(2));
    arrive();
    auto.onWalkEnded(true, null, character(2));
    auto.onCharacter(listed(character(2), '90 gold crowns'));
    drain();
    expect(sent).toEqual(['list']);
    // Three at 9,000 each, charm unread and so priced at its floor: ten percent on.
    expect(decisions.at(-1)?.refused).toContain('29,700 copper');
    expect(decisions.at(-1)?.refused).toContain('no bank on record');
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

/*
 * The bug todo 03 was reported for: killed and sent to the temple, the pack
 * emptied onto the corpse, the client walked the character straight back out to
 * the General Store. Standing still is not a reason to go shopping.
 */
/*
 * The other end of the list (todo 05). A list states how many of a thing to
 * carry, so it has to answer for the number being *exceeded* as well as for it
 * being short — `max 2` meaning *at least 2* is a key nobody wanted a third of
 * riding along for ever.
 */
describe('what the pack holds over the maximum', () => {
  /** A pack of `torches`, `equipped` of which are in a slot. */
  const holding = (torches: number, equipped = 0): CharacterState => {
    const base = character(torches);
    return {
      ...base,
      inventory: {
        ...base.inventory,
        items: base.inventory.items.map((item, at) =>
          at < equipped ? { ...item, equipped: true } : item
        )
      }
    };
  };

  it('puts one spare down, and says why', () => {
    const { planner: p } = planner();
    make(p).onCharacter(holding(6));
    drain();
    expect(sent).toEqual(['drop torch']);
    expect(notices.join(' ')).toContain('Dropping a spare torch');
    // A decision somebody will ask about, so it is on the safety trace as an
    // action rather than only in the queue's reason.
    expect(decisions.some((d) => d.action === 'supplies' && d.acted)).toBe(true);
  });

  it('puts nothing down at the maximum, or under it', () => {
    const { planner: p } = planner();
    make(p).onCharacter(holding(5));
    drain();
    expect(sent).toEqual([]);
  });

  it('one at a time: nothing more until the pack has answered', () => {
    const { planner: p } = planner();
    const supplies = make(p);
    // A status line arrives every few hundred milliseconds and the pack
    // listing that says the surplus is gone arrives seconds later. Without a
    // declared postcondition the character puts its whole stock on the floor
    // in between.
    for (let i = 0; i < 6; i += 1) {
      supplies.onCharacter(holding(7));
      drain();
    }
    expect(sent).toEqual(['drop torch']);
  });

  it('and proposes again once the deadline passes with the pack unchanged', () => {
    const { planner: p } = planner();
    const supplies = make(p);
    supplies.onCharacter(holding(7));
    drain();
    vi.advanceTimersByTime(TUNING.supplies.buyTimeoutMs + 1);
    supplies.onCharacter(holding(7));
    drain();
    expect(sent).toEqual(['drop torch', 'drop torch']);
  });

  /*
   * The refusal that is the point rather than caution: dropping a lit torch in
   * a dark room is the client putting a character somewhere it cannot see.
   */
  it('never puts down one that is in use, and says every one is', () => {
    const { planner: p } = planner();
    make(p).onCharacter(holding(6, 6));
    drain();
    expect(sent).toEqual([]);
    expect(notices.join(' ')).toContain('every one is in use');
  });

  it('takes the spare rather than the one in use', () => {
    const { planner: p } = planner();
    make(p).onCharacter(holding(6, 5));
    drain();
    expect(sent).toEqual(['drop torch']);
  });

  it('stands aside for anything else that has the character', () => {
    for (const over of [
      { walking: () => true },
      { busy: () => true },
      { moveInFlight: () => true }
    ]) {
      sent = [];
      const { planner: p } = planner(over);
      make(p).onCharacter(holding(6));
      drain();
      expect(sent).toEqual([]);
    }
  });

  it('needs no lap: a ceiling is not a shopping trip', () => {
    const { planner: p } = planner({ looping: () => false });
    make(p).onCharacter(holding(6));
    drain();
    expect(sent).toEqual(['drop torch']);
  });
});

describe('a row that names no shop', () => {
  const KEYS: SuppliesConfig = {
    enabled: true,
    items: [{ name: 'black star key', min: 2, max: 2, shop: '', at: null }]
  };

  it('is never walked to a shop, and never refused for having none', () => {
    const { planner: p, log } = planner({
      shopRoom: () => 'no shop is named for it'
    });
    make(p, KEYS).onCharacter(character(1));
    drain();
    // Found rather than bought (`AutoLoot.stockingUp`), so a status line does
    // not say *nowhere to buy* about a row that is working correctly.
    expect(sent).toEqual([]);
    expect(log).toEqual([]);
    expect(notices).toEqual([]);
  });

  it('still has its ceiling kept', () => {
    const { planner: p } = planner();
    const base = character(0);
    make(p, KEYS).onCharacter({
      ...base,
      inventory: {
        ...base.inventory,
        items: [wireItem('black star key'), wireItem('black star key'), wireItem('black star key')]
      }
    });
    drain();
    expect(sent).toEqual(['drop black star key']);
  });
});

describe('when an errand may start at all', () => {
  it('starts nothing from an idle character with no lap running', () => {
    const { planner: p, log } = planner({ looping: () => false });
    const auto = make(p);
    auto.onCharacter(character(0));
    expect(auto.current).toBeNull();
    expect(log).toEqual([]);
  });

  it('starts one while a lap is running', () => {
    const { planner: p } = planner({ looping: () => true });
    const auto = make(p);
    auto.onCharacter(character(0));
    expect(auto.current).not.toBeNull();
  });

  /* The second moment: the player asked to walk somewhere. */
  it('starts one when a route is asked for, lap or no lap', () => {
    const { planner: p } = planner({ looping: () => false });
    const auto = make(p);
    const errand = auto.considerBeforeRoute(character(0));
    expect(errand?.item.name).toBe('torch');
    expect(auto.current).toBe(errand);
  });

  it('starts nothing for a route while one is already running', () => {
    const { planner: p } = planner({ looping: () => true });
    const auto = make(p);
    auto.onCharacter(character(0));
    expect(auto.considerBeforeRoute(character(0))).toBeNull();
  });

  it('starts nothing for a route with the pack already stocked', () => {
    const { planner: p } = planner({ looping: () => false });
    const auto = make(p);
    expect(auto.considerBeforeRoute(character(9))).toBeNull();
  });
});

describe('a purse short of the price', () => {
  const GODFREY: CashPlace = {
    shop: 8,
    name: 'Bank of Godfrey',
    map: 1,
    room: 2170,
    roomName: 'Bank of Godfrey',
    copper: 9_000_000,
    detour: 4,
    moves: 6
  };
  const SILVERMERE: CashPlace = { ...GODFREY, shop: 9, name: 'Silvermere Bank', room: 3000 };
  const broke = (torches = 2): CharacterState => {
    const state = character(torches);
    return { ...state, inventory: { ...state.inventory, wealth: 0 } };
  };
  const stated = (state: CharacterState, copper: number, shop = 8): CharacterState => ({
    ...state,
    banks: [
      { shop, name: shop === 8 ? 'Bank of Godfrey' : 'Silvermere Bank', copper, at: Date.now() + 1 }
    ]
  });

  it('goes to the bank the record says holds it, withdraws, and walks on to the counter', () => {
    const asked: number[] = [];
    const {
      planner: p,
      log,
      goTo,
      arrive
    } = planner({
      priceAt: () => 500,
      cashFrom: (need) => {
        asked.push(need);
        return [GODFREY];
      }
    });
    const auto = make(p);
    auto.onCharacter(broke());
    // Three torches at 500, charm unread: 550 each.
    expect(asked).toEqual([1650]);
    expect(log).toEqual(['hold', 'route:1/2170', 'walk']);
    expect(notices[0]).toContain('Bank of Godfrey');
    expect(decisions[0]).toMatchObject({ action: 'supplies', acted: true });

    goTo('1/2170');
    auto.onWalkEnded(true, null, broke());
    drain();
    expect(sent).toEqual(['bank']);
    expect(auto.current?.stage).toBe('balance');

    auto.onCharacter(stated(broke(), 9_000_000));
    drain();
    expect(sent).toEqual(['bank', `withdraw ${1650 + TUNING.supplies.cashBuffer}`]);

    auto.onBlock(block('user-withdraws', { amount: '2650' }), broke());
    expect(log.slice(-2)).toEqual(['route:1/2147', 'walk']);
    expect(notices.at(-1)).toContain('Withdrew 2650');
    arrive();
    auto.onWalkEnded(true, null, broke());
    drain();
    expect(sent.at(-1)).toBe('list');
  });

  it('prices a charm it has read', () => {
    const asked: number[] = [];
    const { planner: p } = planner({
      priceAt: () => 500,
      cashFrom: (need) => (asked.push(need), [GODFREY])
    });
    const state = broke();
    make(p).onCharacter({ ...state, progress: { ...state.progress, charm: 70 } });
    // (70 − 50) ÷ 5 = 4% off: 480 each.
    expect(asked).toEqual([1440]);
  });

  it('never asks for more than the vault holds', () => {
    const { planner: p, goTo } = planner({ priceAt: () => 500, cashFrom: () => [GODFREY] });
    const auto = make(p);
    auto.onCharacter(broke());
    goTo('1/2170');
    auto.onWalkEnded(true, null, broke());
    auto.onCharacter(stated(broke(), 2000));
    drain();
    expect(sent).toEqual(['bank', 'withdraw 2000']);
  });

  it('falls back to the next bank when the first is short of what the record said', () => {
    const {
      planner: p,
      log,
      goTo
    } = planner({
      priceAt: () => 500,
      cashFrom: () => [GODFREY, SILVERMERE]
    });
    const auto = make(p);
    auto.onCharacter(broke());
    goTo('1/2170');
    auto.onWalkEnded(true, null, broke());
    auto.onCharacter(stated(broke(), 100));
    drain();
    expect(sent).toEqual(['bank']);
    expect(log.slice(-2)).toEqual(['route:1/3000', 'walk']);
    expect(notices.some((n) => n.includes('holds 100 copper'))).toBe(true);
  });

  it('refuses when no bank on record holds the rest, and walks nowhere', () => {
    const { planner: p, log } = planner({ priceAt: () => 500 });
    const auto = make(p);
    auto.onCharacter(broke());
    expect(log).toEqual(['hold', 'release']);
    expect(auto.current).toBeNull();
    expect(decisions.at(-1)?.refused).toContain('1,650 copper');
  });

  it('refuses when the only bank turns out short, naming it', () => {
    const { planner: p, log, goTo } = planner({ priceAt: () => 500, cashFrom: () => [GODFREY] });
    const auto = make(p);
    auto.onCharacter(broke());
    goTo('1/2170');
    auto.onWalkEnded(true, null, broke());
    auto.onCharacter(stated(broke(), 100));
    expect(auto.current).toBeNull();
    expect(log.at(-1)).toBe('release');
    expect(decisions.at(-1)?.refused).toContain('no other bank');
  });

  it('takes a withdrawal the bank never answers as refused', () => {
    const { planner: p, log, goTo } = planner({ priceAt: () => 500, cashFrom: () => [GODFREY] });
    const auto = make(p);
    auto.onCharacter(broke());
    goTo('1/2170');
    auto.onWalkEnded(true, null, broke());
    auto.onCharacter(stated(broke(), 9_000_000));
    drain();
    vi.advanceTimersByTime(TUNING.supplies.buyTimeoutMs + 1);
    expect(auto.current).toBeNull();
    expect(log.at(-1)).toBe('release');
    expect(notices.some((n) => n.includes('did not pay out'))).toBe(true);
    expect(decisions.at(-1)?.refused).toContain('no other bank');
  });

  it('falls to the next vault when one never states a balance', () => {
    const {
      planner: p,
      log,
      goTo
    } = planner({
      priceAt: () => 500,
      cashFrom: () => [GODFREY, SILVERMERE]
    });
    const auto = make(p);
    auto.onCharacter(broke());
    goTo('1/2170');
    auto.onWalkEnded(true, null, broke());
    vi.advanceTimersByTime(TUNING.supplies.buyTimeoutMs + 1);
    expect(auto.current?.stage).toBe('walking');
    expect(log.slice(-2)).toEqual(['route:1/3000', 'walk']);
    expect(notices.some((n) => n.includes('did not state a balance'))).toBe(true);
  });

  it('does not take a withdrawal the player typed for the one it asked', () => {
    const { planner: p, log, goTo } = planner({ priceAt: () => 500, cashFrom: () => [GODFREY] });
    const auto = make(p);
    auto.onCharacter(broke());
    goTo('1/2170');
    auto.onWalkEnded(true, null, broke());
    auto.onCharacter(stated(broke(), 9_000_000));
    auto.onBlock(block('user-withdraws', { amount: '1' }), broke());
    expect(auto.current?.stage).toBe('withdrawing');
    expect(log.at(-1)).toBe('walk');
  });

  it('checks the whole errand against the purse at the counter, not one', () => {
    const { planner: p, log, arrive } = planner({ cashFrom: () => [GODFREY] });
    const auto = make(p);
    const state = character(2);
    const purse = { ...state, inventory: { ...state.inventory, wealth: 600 } };
    auto.onCharacter(purse);
    arrive();
    auto.onWalkEnded(true, null, purse);
    auto.onCharacter(listed(purse, '50 silver nobles'));
    drain();
    // Three at 550 is 1,650 against 600: to the vault, not to `buy`.
    expect(sent).toEqual(['list']);
    expect(log.slice(-2)).toEqual(['route:1/2170', 'walk']);
  });

  it('goes to the bank from the counter when only the quote says the purse is short', () => {
    const { planner: p, log, arrive } = planner({ cashFrom: () => [GODFREY] });
    const auto = make(p);
    auto.onCharacter(character(2));
    arrive();
    auto.onWalkEnded(true, null, character(2));
    auto.onCharacter(listed(character(2), '90 gold crowns'));
    drain();
    expect(sent).toEqual(['list']);
    expect(log.slice(-2)).toEqual(['route:1/2170', 'walk']);
    expect(auto.current?.stage).toBe('walking');
    // The counter's own deadline went with it: the walk to the vault outlives it.
    vi.advanceTimersByTime(TUNING.supplies.buyTimeoutMs + 1);
    expect(auto.current?.stage).toBe('walking');
  });

  it('asks the vault once per errand, and then refuses a quote the purse still cannot meet', () => {
    const { planner: p, goTo, arrive } = planner({ cashFrom: () => [GODFREY] });
    const auto = make(p);
    auto.onCharacter(character(2));
    arrive();
    auto.onWalkEnded(true, null, character(2));
    auto.onCharacter(listed(character(2), '90 gold crowns'));
    goTo('1/2170');
    auto.onWalkEnded(true, null, character(2));
    auto.onCharacter(stated(character(2), 9_000_000));
    auto.onBlock(block('user-withdraws', { amount: '25700' }), character(2));
    arrive();
    auto.onWalkEnded(true, null, character(2));
    auto.onCharacter(listed(character(2), '90 gold crowns'));
    expect(auto.current).toBeNull();
    expect(decisions.at(-1)?.refused).toContain('is quoted at 9,000 copper');
  });
});
