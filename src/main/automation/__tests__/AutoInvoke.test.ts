import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AutoInvoke, type InvokeSources } from '../AutoInvoke';
import { CommandQueue } from '../CommandQueue';
import { EMPTY_CHARACTER, type CarriedItem, type CharacterState } from '../../../shared/character';
import { DEFAULT_CONFIG, type AutomationConfig } from '../../../shared/config';
import { wireItem } from '../../../shared/entities';
import type { WorldItem, WorldSpell } from '../../../shared/world';

const automation: AutomationConfig = {
  ...DEFAULT_CONFIG.automation,
  pacing: { window: 8, minGapMs: 0, ackTimeoutMs: 1000 }
};

/*
 * The `shimmering longsword`, verbatim out of the shipped realm — the item this
 * was reported from. `[43, 114]` at slot 2 is the bless it can be asked for;
 * `[114, 40], [43, 170]` at slots 3 and 4 are a forty-per-cent chance on hit
 * that no command can trigger.
 */
const LONGSWORD: WorldItem = {
  id: 900,
  name: 'shimmering longsword',
  uses: -1,
  abilities: [
    [28, 1],
    [86, 50],
    [43, 114],
    [114, 40],
    [43, 170],
    [135, 10]
  ]
};

/** `weapon major bless`, duration 60 — the spell the longsword casts. */
const BLESS: WorldSpell = { id: 114, name: 'weapon major bless', duration: 60 };

const carried = (name: string): CarriedItem => ({ ...wireItem(name) });

function state(over: Partial<CharacterState> = {}, items = [carried('shimmering longsword')]) {
  const base = structuredClone(EMPTY_CHARACTER);
  return {
    ...base,
    phase: 'in-game' as const,
    name: 'Festus',
    // A listed pack: an unlisted one is not an empty one, and this refuses on
    // that silence.
    inventory: { ...base.inventory, items, listedAt: 1_000 },
    ...over
  };
}

const sources = (over: Partial<InvokeSources> = {}): InvokeSources => ({
  itemNamed: (name) => (name.toLowerCase() === 'shimmering longsword' ? LONGSWORD : null),
  spellById: (id) => (id === 114 ? BLESS : null),
  spellNamed: (name) => (name.trim().toLowerCase() === 'weapon major bless' ? BLESS : null),
  ...over
});

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

const run = (over: Partial<InvokeSources> = {}, on = true): AutoInvoke =>
  new AutoInvoke(on, queue, sources(over));

describe('asking a carried item for its blessing', () => {
  it('uses the weapon that can bless, when the bless is not up', () => {
    run().consider(state());
    vi.advanceTimersByTime(200);
    expect(sent).toEqual(['use shimmering longsword']);
  });

  it('does nothing when it was not asked to', () => {
    run({}, false).consider(state());
    vi.advanceTimersByTime(200);
    expect(sent).toEqual([]);
  });

  /*
   * The buff is up — under the spell's own name here, and under a candidate in
   * the test below. `You feel lucky!` is five spells, so a bless that landed as
   * one of the others is still up.
   */
  it('does not ask for a blessing that is already up', () => {
    run().consider(state({ buffs: [{ spell: 'weapon major bless', by: null, appliedAt: 0 }] }));
    vi.advanceTimersByTime(200);
    expect(sent).toEqual([]);
  });

  it('reads a buff held under one of its other names', () => {
    run().consider(
      state({
        buffs: [{ spell: 'chant', by: null, appliedAt: 0, candidates: ['weapon major bless'] }]
      })
    );
    vi.advanceTimersByTime(200);
    expect(sent).toEqual([]);
  });

  /*
   * The refusal that costs something to get wrong. An item with three charges
   * spent on a buff is three charges somebody was saving — so the realm has to
   * *say* unlimited, and silence is not unlimited.
   */
  it('refuses an item with a limited number of uses', () => {
    const limited: WorldItem = { ...LONGSWORD, uses: 3 };
    run({ itemNamed: () => limited }).consider(state());
    vi.advanceTimersByTime(200);
    expect(sent).toEqual([]);
  });

  it('refuses an item the realm says nothing about', () => {
    const silent: WorldItem = { id: 1, name: 'shimmering longsword', abilities: [[43, 114]] };
    run({ itemNamed: () => silent }).consider(state());
    vi.advanceTimersByTime(200);
    expect(sent).toEqual([]);
  });

  /* A spell with no duration is not a blessing; `use`-ing it spends a command
     to be refused, in the room. */
  it('refuses a spell that is not a blessing', () => {
    run({ spellById: () => ({ id: 114, name: 'fireball' }) }).consider(state());
    vi.advanceTimersByTime(200);
    expect(sent).toEqual([]);
  });

  /* A chance-on-hit proc is not something any command can trigger. */
  it('refuses an item whose only spell is a proc', () => {
    const proc: WorldItem = {
      id: 2,
      name: 'shimmering longsword',
      uses: -1,
      abilities: [
        [114, 40],
        [43, 170]
      ]
    };
    run({ itemNamed: () => proc }).consider(state());
    vi.advanceTimersByTime(200);
    expect(sent).toEqual([]);
  });

  /* A `use` spends the round the way a cast does. */
  it('does not spend a round in a fight', () => {
    run().consider(state({ inCombat: true }));
    vi.advanceTimersByTime(200);
    expect(sent).toEqual([]);
  });

  /*
   * An unlisted pack is not an empty one — the router and `AutoKeys` refuse on
   * the same silence rather than asking for items nobody has read.
   */
  it('waits for the pack to have been read', () => {
    const base = state();
    run().consider({ ...base, inventory: { ...base.inventory, listedAt: null } });
    vi.advanceTimersByTime(200);
    expect(sent).toEqual([]);
  });

  it('says nothing about an item the realm does not know', () => {
    run().consider(state({}, [carried('rusty spoon')]));
    vi.advanceTimersByTime(200);
    expect(sent).toEqual([]);
  });

  /*
   * One per state change. Two `use` commands in a breath is two rounds spent,
   * and the second buff is still there to ask for on the next status line.
   */
  it('asks for one at a time', () => {
    const second: WorldItem = { ...LONGSWORD, id: 901, name: 'black flail' };
    const invoke = new AutoInvoke(true, queue, {
      itemNamed: (name) =>
        name === 'shimmering longsword' ? LONGSWORD : name === 'black flail' ? second : null,
      spellById: (id) => (id === 114 ? BLESS : null),
      spellNamed: () => BLESS
    });
    invoke.consider(state({}, [carried('shimmering longsword'), carried('black flail')]));
    vi.advanceTimersByTime(200);
    expect(sent).toEqual(['use shimmering longsword']);
  });

  /*
   * And it is not re-sent on every status line. The buff landing is what
   * actually stops it — the spell's onset reaches `state.buffs` through the
   * message table — and this is the floor under a `use` the server swallowed.
   */
  it('does not ask again on the next state change', () => {
    const invoke = run();
    invoke.consider(state());
    vi.advanceTimersByTime(200);
    invoke.consider(state());
    vi.advanceTimersByTime(200);
    expect(sent).toEqual(['use shimmering longsword']);
  });
});
