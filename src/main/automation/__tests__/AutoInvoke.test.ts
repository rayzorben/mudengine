import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AutoInvoke, type InvokeSources } from '../AutoInvoke';
import { CommandQueue } from '../CommandQueue';
import { EMPTY_CHARACTER, type CarriedItem, type CharacterState } from '../../../shared/character';
import { DEFAULT_CONFIG, type AutomationConfig } from '../../../shared/config';
import { wireItem } from '../../../shared/entities';
import type { WorldItem, WorldSpell } from '../../../shared/world';
import type { SafetyDecision } from '../../../shared/automation';
import type { BlockType } from '../../../shared/blocks';
import { blockOf } from '../../../shared/__tests__/blocks';
import type { DecisionKind } from '../../../shared/decisionSettings';

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
  handsOf: () => 1,
  fightHere: () => false,
  charges: { usesLeft: () => null, lookOnce: () => undefined, used: () => undefined },
  ...over
});

let sent: string[];
/** The setting each sent command's decision files under, in send order. */
let kinds: (DecisionKind | undefined)[];
let queue: CommandQueue;
beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  kinds = [];
  queue = new CommandQueue(automation, {
    send: (command, intent) => {
      sent.push(command);
      kinds.push(intent.decision);
    }
  });
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
    expect(kinds).toEqual(['invoke-item']);
  });

  it('does nothing when it was not asked to', () => {
    run({}, false).consider(state());
    vi.advanceTimersByTime(200);
    expect(sent).toEqual([]);
  });

  /*
   * A cash run's token casts negate magic, which takes the blessing off
   * again, so nothing is used until it has landed; then the use goes.
   */
  it('uses nothing while a token that negates is next, and uses it once that is over', () => {
    const due = { negateDue: true };
    const invoke = new AutoInvoke(
      { invokeItems: true, invokeWith: CHOSEN },
      true,
      queue,
      sources(),
      undefined,
      undefined,
      undefined,
      {},
      due
    );
    invoke.consider(state());
    vi.advanceTimersByTime(200);
    expect(sent).toEqual([]);
    due.negateDue = false;
    invoke.consider(state());
    vi.advanceTimersByTime(200);
    expect(sent).toEqual(['use shimmering longsword']);
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

  /*
   * `You do not have shimmering longsword equipped.` (`UseCommand.cs`), so a
   * bless weapon in the pack is wielded for the `use` and the fighting weapon
   * put back (todo 42).
   */
  it('wields a bless weapon from the pack and puts the fighting weapon back', () => {
    run().consider(
      state({}, [
        { ...carried('broadsword'), slot: 'Weapon Hand' },
        carried('shimmering longsword', false)
      ])
    );
    vi.advanceTimersByTime(200);
    expect(sent).toEqual([
      'wear shimmering longsword',
      'use shimmering longsword',
      'wear broadsword'
    ]);
  });

  /* Armour must be worn in its own place, which this swap does not do. */
  it('leaves bless armour in the pack alone', () => {
    const tome: WorldItem = { ...LONGSWORD, kind: 'armour' };
    run({ itemsNamed: named(() => tome) }).consider(
      state({}, [carried('shimmering longsword', false)])
    );
    vi.advanceTimersByTime(200);
    expect(sent).toEqual([]);
  });

  /* Never mid-fight: `use` and `wear` both break combat. */
  it('does not start a swap in a fight', () => {
    run().consider(state({ inCombat: true }, [carried('shimmering longsword', false)]));
    vi.advanceTimersByTime(200);
    expect(sent).toEqual([]);
  });

  /* An `aa` unanswered is not yet a fight on the status line, but it is one. */
  it('does not start a swap into a fight asked for', () => {
    const pack = [
      { ...carried('broadsword'), slot: 'Weapon Hand' },
      carried('shimmering longsword', false)
    ];
    run({ fightHere: () => true }).consider(state({}, pack));
    vi.advanceTimersByTime(200);
    expect(sent).toEqual([]);
    // Positive control: the same pack with no fight asked for swaps.
    run().consider(state({}, pack));
    vi.advanceTimersByTime(200);
    expect(sent).toHaveLength(3);
  });

  /*
   * A reach weapon for a fight takes the hand mid-swap (`EquipmentManager.wieldFor`):
   * the watch ends and the fighting weapon is handed over, said by that module.
   */
  it('hands the fighting weapon over to a fight mid-swap', () => {
    const notices: string[] = [];
    const invoke = new AutoInvoke(
      { invokeItems: true, invokeWith: CHOSEN },
      true,
      queue,
      sources(),
      undefined,
      undefined,
      undefined,
      { notice: (message) => notices.push(message) }
    );
    // Positive control: nothing started, so there is nothing to hand over.
    expect(invoke.yieldHand()).toBeNull();
    invoke.consider(
      state({}, [
        { ...carried('broadsword'), slot: 'Weapon Hand' },
        carried('shimmering longsword', false)
      ])
    );
    expect(sent).toHaveLength(3);
    expect(invoke.yieldHand()).toBe('broadsword');
    vi.advanceTimersByTime(60_000);
    invoke.consider(
      state({ inCombat: true }, [
        carried('broadsword', false),
        { ...carried('golden pike'), slot: 'Weapon Hand' }
      ])
    );
    expect(notices).toEqual([]);
  });

  /* A gear set's or a reach weapon's `wear` still waiting: the hand is not settled. */
  it('waits for another wear in the queue before swapping', () => {
    const pack = [
      { ...carried('broadsword'), slot: 'Weapon Hand' },
      carried('shimmering longsword', false)
    ];
    // The window full, so the `wear` waits.
    const looks = Array.from({ length: 20 }, (_, index) => `l ${index}`);
    for (const command of [...looks, 'wear club'])
      queue.enqueue({ command, priority: 'probe', coalesceKey: command, reason: 'test' });
    expect(queue.queued((intent) => intent.command === 'wear club')).toBe(true);
    run().consider(state({}, pack));
    expect(queue.queued((intent) => intent.command === 'wear shimmering longsword')).toBe(false);
    // Positive control: the same pack once nothing else waits.
    queue.clear();
    run().consider(state({}, pack));
    expect(sent).toContain('wear shimmering longsword');
  });

  /* A swap the queue dropped before anything went is forgotten, and asked again. */
  it('asks again once the queue has dropped a swap that never started', () => {
    let open = false;
    const gate = { mayCast: () => open, noteCast: vi.fn(), noteFumbled: vi.fn() };
    const invoke = new AutoInvoke(
      { invokeItems: true, invokeWith: CHOSEN },
      true,
      queue,
      sources(),
      gate
    );
    const pack = [
      { ...carried('broadsword'), slot: 'Weapon Hand' },
      carried('shimmering longsword', false)
    ];
    invoke.consider(state({}, pack));
    vi.advanceTimersByTime(200);
    expect(sent).toEqual([]);
    open = true;
    invoke.consider(state({}, pack));
    vi.advanceTimersByTime(200);
    expect(sent).toEqual([
      'wear shimmering longsword',
      'use shimmering longsword',
      'wear broadsword'
    ]);
  });

  /*
   * The swap-back failed: the fighting weapon is not in hand once its `wear`
   * went and `swapBackMs` passed. Said once. The positive control is the
   * same swap with the weapon back, which says nothing.
   */
  it('says when the fighting weapon is not back in hand', () => {
    const notices: string[] = [];
    const invoke = new AutoInvoke(
      { invokeItems: true, invokeWith: CHOSEN },
      true,
      queue,
      sources(),
      undefined,
      undefined,
      undefined,
      { notice: (message) => notices.push(message) }
    );
    const sword = { ...carried('broadsword'), slot: 'Weapon Hand' };
    invoke.consider(state({}, [sword, carried('shimmering longsword', false)]));
    vi.advanceTimersByTime(200);
    expect(sent).toHaveLength(3);
    const blessInHand = [
      { ...carried('broadsword', false) },
      { ...carried('shimmering longsword'), slot: 'Weapon Hand' }
    ];
    invoke.consider(state({}, blessInHand));
    expect(notices).toEqual([]);
    vi.advanceTimersByTime(60_000);
    invoke.consider(state({}, blessInHand));
    invoke.consider(state({}, blessInHand));
    expect(notices).toHaveLength(1);
  });

  it('says nothing when the fighting weapon is back', () => {
    const notices: string[] = [];
    const invoke = new AutoInvoke(
      { invokeItems: true, invokeWith: CHOSEN },
      true,
      queue,
      sources(),
      undefined,
      undefined,
      undefined,
      { notice: (message) => notices.push(message) }
    );
    const sword = { ...carried('broadsword'), slot: 'Weapon Hand' };
    const pack = [sword, carried('shimmering longsword', false)];
    invoke.consider(state({}, pack));
    vi.advanceTimersByTime(200);
    expect(sent).toHaveLength(3);
    invoke.consider(
      state({ buffs: [{ spell: 'weapon major bless', by: null, appliedAt: 0 }] }, pack)
    );
    vi.advanceTimersByTime(60_000);
    invoke.consider(state({ inCombat: true }, pack));
    expect(notices).toEqual([]);
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
    const held = { mayCast: vi.fn(() => false), noteCast: vi.fn(), noteFumbled: vi.fn() };
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

  /* Todo 41: Auto Choose Blessings' items stand in for the hand list where it has chosen. */
  it('uses the items Auto Choose Blessings picked, else the ticked ones', () => {
    const picked = (items: readonly string[] | null) =>
      new AutoInvoke(
        { invokeItems: true, invokeWith: [] },
        true,
        queue,
        sources(),
        undefined,
        undefined,
        { chosenItems: () => items }
      );
    picked(null).consider(state());
    vi.advanceTimersByTime(200);
    expect(sent).toEqual([]);
    picked(CHOSEN).consider(state());
    vi.advanceTimersByTime(200);
    expect(sent).toEqual(['use shimmering longsword']);
  });

  /* Todo 42: the chooser priced the swap and picked the weapon in the pack. */
  it('swaps to a picked weapon in the pack', () => {
    new AutoInvoke(
      { invokeItems: false, invokeWith: [] },
      true,
      queue,
      sources(),
      undefined,
      undefined,
      { chosenItems: () => CHOSEN }
    ).consider(
      state({}, [
        { ...carried('broadsword'), slot: 'Weapon Hand' },
        carried('shimmering longsword', false)
      ])
    );
    vi.advanceTimersByTime(200);
    expect(sent).toEqual([
      'wear shimmering longsword',
      'use shimmering longsword',
      'wear broadsword'
    ]);
  });

  /* Todo 41: the switch is for the hand list; a picked item would otherwise go unused. */
  it('uses a picked item with the hand list switched off, and not the hand list', () => {
    const listOff = (items: readonly string[] | null) =>
      new AutoInvoke(
        { invokeItems: false, invokeWith: CHOSEN },
        true,
        queue,
        sources(),
        undefined,
        undefined,
        { chosenItems: () => items }
      );
    listOff(null).consider(state());
    vi.advanceTimersByTime(200);
    expect(sent).toEqual([]);
    listOff(CHOSEN).consider(state());
    vi.advanceTimersByTime(200);
    expect(sent).toEqual(['use shimmering longsword']);
  });

  /* Todo 41: zeal takes the warhorn's blast off, so the blast is not used while zeal is up. */
  it('leaves a blessing up that its spell would take off, or that takes it off', () => {
    const zeal: WorldSpell = { id: 304, name: 'zeal', duration: 10, abilities: [[122, 114]] };
    const over: Partial<InvokeSources> = {
      spellNamed: (name) => (name === 'zeal' ? zeal : name === 'weapon major bless' ? BLESS : null)
    };
    // Positive control: another blessing up, and the item is used.
    run(over).consider(state({ buffs: [{ spell: 'chant', by: null, appliedAt: 0 }] }));
    vi.advanceTimersByTime(200);
    expect(sent).toEqual(['use shimmering longsword']);
    sent.length = 0;
    run(over).consider(state({ buffs: [{ spell: 'zeal', by: null, appliedAt: 0 }] }));
    vi.advanceTimersByTime(200);
    expect(sent).toEqual([]);
  });
});

/*
 * The server's answer to a `use` (todo 43). The sentences are `UseCommand.cs`
 * and `Player.InitiateSpell` / `TryInvokeSpell`; none is captured yet.
 */
describe('reading the answer to a use', () => {
  const answer = (type: BlockType, groups: Record<string, string> = {}) =>
    blockOf(type, '', groups, Date.now());

  /** Sends one `use`, answers it, and asks again a round later. */
  function answered(
    type: BlockType,
    groups: Record<string, string> = {},
    over: Partial<InvokeSources> = {}
  ) {
    const decided: SafetyDecision[] = [];
    const invoke = new AutoInvoke(
      { invokeItems: true, invokeWith: CHOSEN },
      true,
      queue,
      sources(over),
      undefined,
      undefined,
      undefined,
      { decided: (decision) => decided.push(decision) }
    );
    invoke.consider(state());
    vi.advanceTimersByTime(200);
    expect(sent).toEqual(['use shimmering longsword']);
    invoke.onBlock(answer(type, groups), state());
    vi.advanceTimersByTime(5_000);
    invoke.consider(state());
    vi.advanceTimersByTime(200);
    return { invoke, decided };
  }

  // The positive control for every hold below: unanswered, the floor holds it.
  it('waits out the retry floor when nothing answers', () => {
    answered('room-name');
    expect(sent).toEqual(['use shimmering longsword']);
  });

  it('uses it again next round after a failed roll', () => {
    const { decided } = answered('spell-failed', { spell: 'weapon major bless' });
    expect(sent).toEqual(['use shimmering longsword', 'use shimmering longsword']);
    expect(decided).toEqual([]);
  });

  it('reads nothing after the use has landed', () => {
    const { invoke } = answered('spell-onset');
    invoke.onBlock(answer('spell-short-of-mana'), state());
    vi.advanceTimersByTime(30_000);
    invoke.consider(state());
    vi.advanceTimersByTime(200);
    expect(sent).toEqual(['use shimmering longsword', 'use shimmering longsword']);
  });

  it('does not take another spell failing for its own', () => {
    answered('spell-failed', { spell: 'bless' });
    expect(sent).toEqual(['use shimmering longsword']);
  });

  it('uses it again next round when the round was already spent', () => {
    answered('spell-refused');
    expect(sent).toEqual(['use shimmering longsword', 'use shimmering longsword']);
  });

  /*
   * The shimmering greatsword casts weapon major bless and then silvery mace;
   * the second is refused every time, so the refusal says nothing of the bless.
   */
  it('reads no spent round off an item that casts several spells', () => {
    const greatsword: WorldItem = {
      ...LONGSWORD,
      abilities: [
        [43, 114],
        [114, 40],
        [135, 20],
        [43, 170]
      ]
    };
    answered('spell-refused', {}, { itemsNamed: named(() => greatsword) });
    expect(sent).toEqual(['use shimmering longsword']);
  });

  it('holds the item and says so when the mana is short, until it rises', () => {
    const { invoke, decided } = answered('spell-short-of-mana');
    expect(sent).toEqual(['use shimmering longsword']);
    expect(decided).toHaveLength(1);
    expect(decided[0]).toMatchObject({ action: 'use', acted: false });
    const base = state();
    invoke.consider({ ...base, vitals: { ...base.vitals, mana: (base.vitals.mana ?? 0) + 10 } });
    vi.advanceTimersByTime(200);
    expect(sent).toEqual(['use shimmering longsword', 'use shimmering longsword']);
  });

  it('holds a weapon refused as not equipped until the pack is listed again', () => {
    const { invoke, decided } = answered('item-not-equipped', { item: 'shimmering longsword' });
    expect(sent).toEqual(['use shimmering longsword']);
    expect(decided).toHaveLength(1);
    const base = state();
    invoke.consider({ ...base, inventory: { ...base.inventory, listedAt: 2_000 } });
    vi.advanceTimersByTime(200);
    expect(sent).toEqual(['use shimmering longsword', 'use shimmering longsword']);
  });

  it('holds an item the server says is used up for the session', () => {
    const { invoke, decided } = answered('item-used-up', { item: 'shimmering longsword' });
    expect(decided).toHaveLength(1);
    const base = state();
    invoke.consider({ ...base, inventory: { ...base.inventory, listedAt: 2_000 } });
    vi.advanceTimersByTime(200);
    expect(sent).toEqual(['use shimmering longsword']);
  });
});

/*
 * A charged item kept at none and recharged at the new day (todo 44), as
 * gmud.zip's cloak of faith is: 3 uses, 3 back at each cleanup.
 */
describe('a charged bless item whose uses come back', () => {
  const RENEWING: WorldItem = {
    ...LONGSWORD,
    uses: 3,
    retains: true,
    abilities: [[121, 3], ...(LONGSWORD.abilities ?? [])]
  };
  const ledger = (left: number | null) => {
    const asked = { looks: [] as string[], used: [] as string[], left };
    const charges: InvokeSources['charges'] = {
      usesLeft: () => asked.left,
      lookOnce: (item) => void asked.looks.push(item),
      used: (item) => void asked.used.push(item)
    };
    return { asked, charges };
  };
  const make = (charges: InvokeSources['charges'], decided: SafetyDecision[] = []) =>
    new AutoInvoke(
      { invokeItems: true, invokeWith: CHOSEN },
      true,
      queue,
      sources({ itemsNamed: named(() => RENEWING), charges }),
      undefined,
      undefined,
      undefined,
      { decided: (decision) => decided.push(decision) }
    );

  it('looks at it once while its uses are unknown, and uses it', () => {
    const { asked, charges } = ledger(null);
    make(charges).consider(state());
    vi.advanceTimersByTime(200);
    expect(asked.looks).toEqual(['shimmering longsword']);
    expect(sent).toEqual(['use shimmering longsword']);
  });

  it('leaves it at none left until the ledger says the uses are back, said once', () => {
    const { asked, charges } = ledger(0);
    const decided: SafetyDecision[] = [];
    const invoke = make(charges, decided);
    invoke.consider(state());
    invoke.consider(state());
    vi.advanceTimersByTime(200);
    expect(sent).toEqual([]);
    expect(decided).toHaveLength(1);
    // The positive control: the new day gives the uses back.
    asked.left = 3;
    invoke.consider(state());
    vi.advanceTimersByTime(200);
    expect(sent).toEqual(['use shimmering longsword']);
  });

  it('counts a landed use on the ledger', () => {
    const { asked, charges } = ledger(2);
    const invoke = make(charges);
    invoke.consider(state());
    vi.advanceTimersByTime(200);
    invoke.onBlock(blockOf('spell-onset', '', {}, Date.now()), state());
    expect(asked.used).toEqual(['shimmering longsword']);
  });

  it('says it is used up for the day, and holds it only by the count', () => {
    const { asked, charges } = ledger(1);
    const decided: SafetyDecision[] = [];
    const invoke = make(charges, decided);
    invoke.consider(state());
    vi.advanceTimersByTime(200);
    invoke.onBlock(
      blockOf('item-used-up', '', { item: 'shimmering longsword' }, Date.now()),
      state()
    );
    expect(decided).toHaveLength(1);
    asked.left = 3;
    vi.advanceTimersByTime(5_000);
    invoke.consider(state());
    vi.advanceTimersByTime(200);
    expect(sent).toEqual(['use shimmering longsword', 'use shimmering longsword']);
  });

  it('refuses a charged item that is destroyed at its last use', () => {
    const { charges } = ledger(3);
    new AutoInvoke(
      { invokeItems: true, invokeWith: CHOSEN },
      true,
      queue,
      sources({ itemsNamed: named(() => ({ ...RENEWING, retains: undefined })), charges })
    ).consider(state());
    vi.advanceTimersByTime(200);
    expect(sent).toEqual([]);
  });
});
