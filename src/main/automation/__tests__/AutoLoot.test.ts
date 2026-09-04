import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AutoLoot } from '../AutoLoot';
import { CommandQueue } from '../CommandQueue';
import { DEFAULT_CONFIG, type AutomationConfig, type LootConfig } from '../../../shared/config';
import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';
import { domainOf, type Block, type BlockType } from '../../../shared/blocks';
import { wireItem } from '../../../shared/entities';

const automation: AutomationConfig = {
  ...DEFAULT_CONFIG.automation,
  pacing: { window: 8, minGapMs: 0, ackTimeoutMs: 1000 }
};

const loot = (over: Partial<LootConfig> = {}): LootConfig => ({
  ...DEFAULT_CONFIG.automation.loot,
  ...over
});

let seq = 0;
/** A block as the classifier would have built it — the fact, not the line. */
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

function state(over: Partial<CharacterState['vitals']> = {}): CharacterState {
  const base = structuredClone(EMPTY_CHARACTER);
  return { ...base, phase: 'in-game', vitals: { ...base.vitals, ...over } };
}

let sent: string[];
let queue: CommandQueue;

beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  queue = new CommandQueue(automation, { send: (command) => sent.push(command) });
});

afterEach(() => {
  queue.dispose();
  vi.useRealTimers();
});

const make = (config: LootConfig, enabled = true): AutoLoot => new AutoLoot(config, enabled, queue);

/**
 * A realm that prices and weighs three things and has never heard of anything
 * else — which is the shape every derivative realm has, and the one the
 * predicates have to decline safely on.
 */
const REALM: Record<string, { price?: number; encumbrance?: number }> = {
  'gold ring': { price: 5_000, encumbrance: 1 },
  'iron anvil': { price: 9_000, encumbrance: 900 },
  'rusty nail': { price: 0, encumbrance: 1 }
};
const withRealm = (config: LootConfig): AutoLoot =>
  new AutoLoot(config, true, queue, (name) => ({
    ...wireItem(name),
    ...(REALM[name.toLowerCase()] ?? {}),
    source: REALM[name.toLowerCase()] === undefined ? 'wire' : 'hybrid'
  }));
const drain = (): void => void vi.advanceTimersByTime(500);

describe('coins on the floor', () => {
  it('picks up coins the moment they land', () => {
    const auto = make(loot({ coins: true }));
    auto.onBlock(block('room-coins', { count: '18', coin: 'gold' }), state());
    drain();
    expect(sent).toEqual(['get gold']);
  });

  it('picks up coins a look lists, and only the coins', () => {
    const auto = make(loot({ coins: true }));
    auto.onBlock(
      block('room-items', { items: '5 silver nobles, 17 copper farthings, a rusty key' }),
      state()
    );
    drain();
    expect(sent).toEqual(['get silver', 'get copper']);
  });

  it('does nothing when coins are off, or automation is off', () => {
    make(loot({ coins: false })).onBlock(
      block('room-coins', { count: '3', coin: 'gold' }),
      state()
    );
    make(loot({ coins: true }), false).onBlock(
      block('room-coins', { count: '3', coin: 'gold' }),
      state()
    );
    drain();
    expect(sent).toEqual([]);
  });

  it('coalesces two drops of one coin in a round into one get, and keeps two coins apart', () => {
    const auto = make(loot({ coins: true }));
    auto.onBlock(block('room-coins', { count: '3', coin: 'gold' }), state());
    auto.onBlock(block('room-coins', { count: '4', coin: 'gold' }), state());
    auto.onBlock(block('room-coins', { count: '1', coin: 'silver' }), state());
    drain();
    expect(sent).toEqual(['get gold', 'get silver']);
  });
});

/*
 * Cash a `search` turned up.
 *
 * Measured on the live realm 2026-09-02, the same room twice: `4 copper
 * farthings` in the listing, `get copper` answered `You don't see any copper
 * farthings`, and `g 4 cop` took them. Seven of seven bare gets at searched-up
 * coins were refused that way across the recorded sessions, and every counted
 * one was taken.
 */
describe('cash a search turned up', () => {
  it('asks for it by quantity, which is the only form the server takes', () => {
    const auto = make(loot({ coins: true }));
    auto.onBlock(
      block('room-hidden-items', { items: '4 copper farthings, scroll of minor healing' }),
      state()
    );
    drain();
    expect(sent).toEqual(['get 4 copper']);
  });

  /*
   * And the open floor keeps the bare form, which is the whole reason the two
   * listings are told apart: a drop line states one pile while the floor may
   * hold several, so a counted get there would take one and leave the rest.
   */
  it('leaves the open floor asking bare', () => {
    const auto = make(loot({ coins: true }));
    auto.onBlock(block('room-items', { items: '4 copper farthings' }), state());
    drain();
    expect(sent).toEqual(['get copper']);
  });

  /* Items are unaffected — `get silver` off a search took `silver ring`. */
  it('still asks for a named item by name', () => {
    const auto = make(loot({ coins: false, items: ['scroll'] }));
    auto.onBlock(
      block('room-hidden-items', { items: '4 copper farthings, scroll of minor healing' }),
      state()
    );
    drain();
    expect(sent).toEqual(['get scroll']);
  });

  /*
   * A repeated search lists the same coins again, and the attempt is keyed on
   * the denomination rather than on the whole `4 copper` phrase — otherwise a
   * pile the client had already failed to take would be asked for again the
   * moment the count it was listed under changed.
   */
  it('asks once per denomination however the listing repeats', () => {
    const auto = make(loot({ coins: true }));
    auto.onBlock(block('room-hidden-items', { items: '4 copper farthings' }), state());
    auto.onBlock(block('room-hidden-items', { items: '4 copper farthings' }), state());
    auto.onBlock(block('room-items', { items: '4 copper farthings' }), state());
    drain();
    expect(sent).toEqual(['get 4 copper']);
  });
});

describe('asking once', () => {
  it('does not ask again for a name the server already refused in this room', () => {
    const auto = make(loot({ coins: true }));
    auto.onBlock(block('room-items', { items: '15 copper farthings' }), state());
    drain();
    auto.onBlock(block('room-items', { items: '15 copper farthings' }), state());
    drain();
    expect(sent).toEqual(['get copper']);
  });

  it('asks again in a new room', () => {
    const auto = make(loot({ coins: true }));
    auto.onBlock(block('room-items', { items: '15 copper farthings' }), state());
    drain();
    auto.onBlock(block('room-name', { name: 'Somewhere Else' }), state());
    auto.onBlock(block('room-items', { items: '15 copper farthings' }), state());
    drain();
    expect(sent).toEqual(['get copper', 'get copper']);
  });

  it('asks again once the pack confirmed the last pick-up', () => {
    const auto = make(loot({ coins: true }));
    auto.onBlock(block('room-coins', { count: '3', coin: 'gold' }), state());
    drain();
    auto.onBlock(block('player-gets', { item: 'gold' }), state());
    auto.onBlock(block('room-coins', { count: '2', coin: 'gold' }), state());
    drain();
    expect(sent).toEqual(['get gold', 'get gold']);
  });
});

describe('named items', () => {
  it('takes a listed item by the prefix the server reads', () => {
    const auto = make(loot({ items: ['rusty key', 'phoenix'] }));
    auto.onBlock(
      block('room-items', { items: 'a rusty key, phoenix feather, 3 gold crowns' }),
      state()
    );
    drain();
    // The article is the listing's; `get` reads a prefix, so the name is sent as configured.
    expect(sent).toEqual(['get phoenix']);
  });

  it('leaves everything unnamed on the floor', () => {
    make(loot({ items: ['phoenix'] })).onBlock(
      block('room-items', { items: 'a rusty key' }),
      state()
    );
    drain();
    expect(sent).toEqual([]);
  });
});

describe('when it stands aside', () => {
  it('never stands a resting character up for coins', () => {
    const auto = make(loot({ coins: true }));
    auto.onBlock(block('room-coins', { count: '9', coin: 'gold' }), state({ resting: true }));
    auto.onBlock(block('room-coins', { count: '9', coin: 'gold' }), state({ meditating: true }));
    drain();
    expect(sent).toEqual([]);
  });

  it('does nothing outside the realm', () => {
    const auto = make(loot({ coins: true }));
    auto.onBlock(block('room-coins', { count: '9', coin: 'gold' }), {
      ...state(),
      phase: 'authenticating'
    });
    drain();
    expect(sent).toEqual([]);
  });
});

/*
 * What the realm's own numbers say to bend down for — the two settings that
 * became askable when a floor item started arriving with its realm row.
 *
 * The cases that matter are the *absences*, and they point opposite ways on
 * purpose: an unpriced item is never taken (a price nobody has stated is not a
 * high one) while an unweighed one is never refused (unknown is not heavy, and
 * refusing on absence would stop a derivative realm looting anything at all).
 */
describe('taking things by what the realm says they are worth', () => {
  const noticed = (...items: string[]): Block => block('room-items', { items: items.join(', ') });

  it('takes what clears the value floor and leaves what does not', () => {
    const auto = withRealm(loot({ minPrice: 1_000 }));
    auto.onBlock(noticed('gold ring', 'rusty nail'), state());
    drain();
    expect(sent).toEqual(['get gold ring']);
  });

  it('never takes something the realm cannot price', () => {
    const auto = withRealm(loot({ minPrice: 1 }));
    auto.onBlock(noticed('gnarled widget'), state());
    drain();
    expect(sent).toEqual([]);
  });

  /*
   * The ceiling outranks a name on the list, because the failure it exists for
   * is an unattended character looting itself over the encumbrance the walker
   * then stalls under — which a name cannot be allowed to cause.
   */
  it('refuses something over the weight ceiling even when it is named', () => {
    const auto = withRealm(loot({ items: ['iron anvil'], maxEncumbrance: 100 }));
    auto.onBlock(noticed('iron anvil'), state());
    drain();
    expect(sent).toEqual([]);
  });

  it('does not refuse something the realm cannot weigh', () => {
    const auto = withRealm(loot({ items: ['gnarled widget'], maxEncumbrance: 1 }));
    auto.onBlock(noticed('gnarled widget'), state());
    drain();
    expect(sent).toEqual(['get gnarled widget']);
  });

  /* Both off is the shipped default, and it must take only what is named. */
  it('does nothing on the realm’s numbers while both are zero', () => {
    const auto = withRealm(loot({ minPrice: 0, maxEncumbrance: 0 }));
    auto.onBlock(noticed('gold ring'), state());
    drain();
    expect(sent).toEqual([]);
  });
});

/*
 * Every coin denomination is also an ordinary English adjective, and the
 * pattern that spots a coin pile used to be anchored only at the start — so a
 * `gold ring` on the floor was read as a pile of gold, `get gold` went into a
 * room with no coins in it, and the ring stayed where it was. One bug for each
 * of the five denominations.
 */
describe('telling a coin pile from a thing that is merely made of one', () => {
  const noticed = (...items: string[]): Block => block('room-items', { items: items.join(', ') });

  it('takes the coins and the thing, and does not confuse them', () => {
    const auto = make(loot({ coins: true, items: ['gold ring'] }));
    auto.onBlock(noticed('15 copper farthings', 'gold ring'), state());
    drain();
    expect(sent).toEqual(['get copper', 'get gold ring']);
  });

  it('reads a bare drop line as coins, as the wire prints it', () => {
    const auto = make(loot({ coins: true }));
    auto.onBlock(noticed('18 gold'), state());
    drain();
    expect(sent).toEqual(['get gold']);
  });

  it('does not read a thing named after a metal as coins', () => {
    const auto = make(loot({ coins: true }));
    auto.onBlock(noticed('silver locket', 'copper kettle', 'platinum band'), state());
    drain();
    expect(sent).toEqual([]);
  });
});

/*
 * Which coins, and when to stop — the cash settings.
 *
 * The complaint they answer is that a lap through a lair fills the purse with
 * copper, and every `get copper` is a command out of the budget the fighting is
 * done from.
 */
describe('choosing which cash to take', () => {
  const noticed = (...items: string[]): Block => block('room-items', { items: items.join(', ') });
  const dropped = (count: number, coin: string): Block =>
    block('room-coins', { count: String(count), coin });

  it('takes only the denominations it was told to', () => {
    const auto = make(loot({ coins: true, coinKinds: ['gold', 'platinum'] }));
    auto.onBlock(noticed('15 copper farthings', '2 gold crowns', '1 platinum piece'), state());
    drain();
    expect(sent).toEqual(['get gold', 'get platinum']);
  });

  /* An empty list is a real answer, and it takes nothing — the settings screen
     says so rather than the switch reading as broken. */
  it('takes nothing when the list is empty, even with the switch on', () => {
    const auto = make(loot({ coins: true, coinKinds: [] }));
    auto.onBlock(dropped(18, 'gold'), state());
    drain();
    expect(sent).toEqual([]);
  });

  /* All five is the default, and it is what `coins: true` alone always meant. */
  it('takes every denomination by default', () => {
    const auto = make(loot({ coins: true }));
    auto.onBlock(noticed('15 copper farthings', '2 gold crowns'), state());
    drain();
    expect(sent).toEqual(['get copper', 'get gold']);
  });

  describe('stopping once the load is graded', () => {
    const loaded = (word: string | null): CharacterState => {
      const base = state();
      return { ...base, inventory: { ...base.inventory, encumbranceWord: word } };
    };

    it('stops at the grade it was given, and not before', () => {
      const auto = make(loot({ coins: true, stopAtGrade: 'heavy' }));
      auto.onBlock(dropped(1, 'gold'), loaded('Medium'));
      drain();
      expect(sent).toEqual(['get gold']);

      sent.length = 0;
      const stopping = make(loot({ coins: true, stopAtGrade: 'medium' }));
      stopping.onBlock(dropped(1, 'gold'), loaded('Medium'));
      drain();
      expect(sent).toEqual([]);
    });

    /*
     * Unknown is not encumbered — `drop.whenEncumbered`'s rule. A grade nobody
     * has sampled must not stop an automation that works: only `None` and
     * `Medium` have ever been seen on the wire.
     */
    it('does not stop on a grade it cannot rank, or on none at all', () => {
      const auto = make(loot({ coins: true, stopAtGrade: 'medium' }));
      auto.onBlock(dropped(1, 'gold'), loaded(null));
      auto.onBlock(dropped(1, 'silver'), loaded('Encumbered Beyond Reason'));
      drain();
      expect(sent).toEqual(['get gold', 'get silver']);
    });
  });
});

/*
 * The coin bag — GreaterMUD's converter, which Daeron Darksong drops.
 *
 * The client cannot tell which item does this (the realm marks it no
 * differently from the other 454 items that cast a spell), so the player names
 * it and this only decides *when*.
 */
describe('converting cash with an item', () => {
  const carrying = (name: string, word: string | null): CharacterState => {
    const base = state();
    return {
      ...base,
      inventory: {
        ...base.inventory,
        encumbranceWord: word,
        items: [wireItem(name)]
      }
    };
  };

  it('uses it once the load is graded heavily enough', () => {
    const auto = make(loot({ convertWith: 'coin bag', convertAt: 'medium' }));
    auto.onBlock(block('status-line'), carrying('coin bag', 'Medium'));
    drain();
    expect(sent).toEqual(['use coin bag']);
  });

  it('leaves it alone below the grade, and with no grade read', () => {
    const auto = make(loot({ convertWith: 'coin bag', convertAt: 'heavy' }));
    auto.onBlock(block('status-line'), carrying('coin bag', 'Medium'));
    auto.onBlock(block('status-line'), carrying('coin bag', null));
    drain();
    expect(sent).toEqual([]);
  });

  /* Asking for something not in the pack is a command spent to be told so,
     out loud in the room. */
  it('never asks for an item the pack does not list', () => {
    const auto = make(loot({ convertWith: 'coin bag', convertAt: 'medium' }));
    auto.onBlock(block('status-line'), carrying('rusty sword', 'Medium'));
    drain();
    expect(sent).toEqual([]);
  });

  it('does nothing while no item is named', () => {
    const auto = make(loot({ convertAt: 'medium' }));
    auto.onBlock(block('status-line'), carrying('coin bag', 'Heavy'));
    drain();
    expect(sent).toEqual([]);
  });
});
