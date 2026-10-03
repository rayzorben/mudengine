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
  kind: 'weapon',
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

/** `weapon major bless`, duration 60, 8 mana — the spell the longsword casts. */
const BLESS: WorldSpell = { id: 114, name: 'weapon major bless', mana: 8, duration: 60 };

/** Wielded, as the server requires of a weapon it is asked to use. */
const carried = (name: string, equipped = true): CarriedItem => ({
  ...wireItem(name),
  equipped
});

const named =
  (lookup: (name: string) => WorldItem | null): InvokeSources['itemsNamed'] =>
  (names) =>
    Object.fromEntries(names.map((name) => [name, lookup(name) ?? undefined]));

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
  itemsNamed: named((name) => (name === 'shimmering longsword' ? LONGSWORD : null)),
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

const CHOSEN = ['shimmering longsword'];

const run = (over: Partial<InvokeSources> = {}, on = true, chosen = CHOSEN): AutoInvoke =>
  new AutoInvoke({ invokeItems: on, invokeWith: chosen }, true, queue, sources(over));

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
    run({ itemsNamed: named(() => limited) }).consider(state());
    vi.advanceTimersByTime(200);
    expect(sent).toEqual([]);
  });

  it('refuses an item the realm says nothing about', () => {
    const silent: WorldItem = { id: 1, name: 'shimmering longsword', abilities: [[43, 114]] };
    run({ itemsNamed: named(() => silent) }).consider(state());
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
    run({ itemsNamed: named(() => proc) }).consider(state());
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
    const second: WorldItem = { ...LONGSWORD, id: 901, name: 'black flail', kind: 'misc' };
    const both = sources({
      itemsNamed: named((name) =>
        name === 'shimmering longsword' ? LONGSWORD : name === 'black flail' ? second : null
      )
    });
    const chosen = { invokeItems: true, invokeWith: ['shimmering longsword', 'black flail'] };
    new AutoInvoke(chosen, true, queue, both).consider(
      state({}, [carried('shimmering longsword'), carried('black flail', false)])
    );
    vi.advanceTimersByTime(200);
    expect(sent).toEqual(['use shimmering longsword']);
  });

  /* The todo's case: several weapons that bless, and only the chosen one used. */
  it('uses only the items chosen', () => {
    run({}, true, []).consider(state());
    run({}, true, ['black flail']).consider(state());
    vi.advanceTimersByTime(200);
    expect(sent).toEqual([]);
    run({}, true, ['Shimmering Longsword']).consider(state());
    vi.advanceTimersByTime(200);
    expect(sent).toEqual(['use shimmering longsword']);
  });

  /* `You do not have shimmering longsword equipped.` (`UseCommand.cs`). */
  it('waits for a weapon to be wielded', () => {
    run().consider(state({}, [carried('shimmering longsword', false)]));
    vi.advanceTimersByTime(200);
    expect(sent).toEqual([]);
  });

  /*
   * An item cast costs the spell's mana: `MA=21` became `MA=13` on festus's
   * `use shimmering longsword`, and short of it the server answers `You do not
   * have enough mana to cast that spell.`
   */
  it('waits for the mana the spell costs', () => {
    const base = state();
    const invoke = run();
    invoke.consider({ ...base, vitals: { ...base.vitals, mana: 7, manaMax: 21 } });
    vi.advanceTimersByTime(200);
    expect(sent).toEqual([]);
    invoke.consider({ ...base, vitals: { ...base.vitals, mana: 8, manaMax: 21 } });
    vi.advanceTimersByTime(200);
    expect(sent).toEqual(['use shimmering longsword']);
  });

  /* A `use` spends the round's magic energy like a cast does. */
  it('holds for the round when a cast has already gone', () => {
    const held = { mayCast: vi.fn(() => false), noteCast: vi.fn() };
    const invoke = new AutoInvoke(
      { invokeItems: true, invokeWith: CHOSEN },
      true,
      queue,
      sources(),
      held
    );
    invoke.consider(state());
    vi.advanceTimersByTime(200);
    expect(held.mayCast).toHaveBeenCalledWith('weapon major bless');
    expect(sent).toEqual([]);
    expect(held.noteCast).not.toHaveBeenCalled();
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
