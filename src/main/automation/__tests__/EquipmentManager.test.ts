import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EquipmentManager, type EquipmentSources } from '../EquipmentManager';
import { CommandQueue } from './../CommandQueue';
import { EMPTY_CHARACTER, type CarriedItem, type CharacterState } from '../../../shared/character';
import { DEFAULT_CONFIG, type AutomationConfig, type GearConfig } from '../../../shared/config';
import { wireItem } from '../../../shared/entities';
import { OFF_HAND, WEAPON_HAND } from '../../../shared/items';
import type { GearSet } from '../../../shared/gear';
import { classifyOccupant } from '../../../shared/mobs';

const automation: AutomationConfig = {
  ...DEFAULT_CONFIG.automation,
  enabled: true,
  pacing: { window: 8, minGapMs: 0, ackTimeoutMs: 1000 }
};

/*
 * The report's own example, verbatim in shape: plate boots while fighting,
 * brown leather boots while walking, and one boss the lap otherwise fights
 * with what the base set holds.
 */
const SETS: GearSet[] = [
  { name: 'Default', when: 'always', mob: '', wear: ['plate boots', 'lifestealer'] },
  { name: 'Moving', when: 'moving', mob: '', wear: ['brown leather boots'] },
  { name: 'Boss', when: 'fighting', mob: 'nasty sandworm', wear: ['nexus spear'] }
];

const SLOTS: Record<string, string> = {
  'plate boots': 'Feet',
  'brown leather boots': 'Feet',
  lifestealer: WEAPON_HAND,
  'nexus spear': WEAPON_HAND,
  'golden chalice': OFF_HAND
};

const gear = (over: Partial<GearConfig> = {}): GearConfig => ({
  ...DEFAULT_CONFIG.automation.gear,
  enabled: true,
  sets: SETS,
  ...over
});

const carried = (name: string): CarriedItem => ({ ...wireItem(name) });
const worn = (name: string, slot: string): CarriedItem => ({
  ...wireItem(name),
  slot,
  equipped: true
});

function standing(items: CarriedItem[], over: Partial<CharacterState> = {}): CharacterState {
  const base = structuredClone(EMPTY_CHARACTER);
  return {
    ...base,
    phase: 'in-game' as const,
    inventory: { ...base.inventory, items, listedAt: 1_000 },
    ...over
  };
}

const fighting = (target: string | null, items: CarriedItem[]): CharacterState =>
  standing(items, {
    inCombat: true,
    combat: { ...structuredClone(EMPTY_CHARACTER).combat, target }
  });

let sent: string[];
let notices: string[];
let queue: CommandQueue;
let clock: number;

const sources = (over: Partial<EquipmentSources> = {}): EquipmentSources => ({
  slotOf: (name) => SLOTS[name] ?? null,
  handsOf: (name) => (name === 'nexus spear' ? 2 : 1),
  opensWithBackstab: () => false,
  yieldSwap: () => null,
  exposureAt: () => ({}),
  placeItem: () => null,
  minSaved: () => 2,
  ...over
});

beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  notices = [];
  clock = Date.now();
  queue = new CommandQueue(automation, { send: (command) => sent.push(command) });
});

afterEach(() => {
  queue.dispose();
  vi.useRealTimers();
});

const make = (config = gear(), over: Partial<EquipmentSources> = {}): EquipmentManager =>
  new EquipmentManager(
    config,
    true,
    queue,
    sources(over),
    { notice: (message) => notices.push(message) },
    () => clock
  );

describe('which kit to be in', () => {
  it('puts the base kit on with nothing else happening', () => {
    make().onCharacter(standing([carried('plate boots'), carried('lifestealer')]), false);
    expect(sent).toEqual(['wear lifestealer', 'wear plate boots']);
  });

  it('swaps only the slot a moving set names, leaving the rest of the base alone', () => {
    const pack = [
      worn('plate boots', 'Feet'),
      worn('lifestealer', WEAPON_HAND),
      carried('brown leather boots')
    ];
    make().onCharacter(standing(pack), true);
    expect(sent).toEqual(['wear brown leather boots']);
  });

  /*
   * The two-handed dance, driven by the situation rather than by a press: the
   * boss row's weapon needs the hand the chalice is in.
   */
  it('takes the off-hand off for the boss set’s two-handed weapon', () => {
    const pack = [
      worn('golden chalice', OFF_HAND),
      worn('lifestealer', WEAPON_HAND),
      worn('plate boots', 'Feet'),
      carried('nexus spear')
    ];
    make().onCharacter(fighting('nasty sandworm', pack), false);
    expect(sent).toEqual(['remove golden chalice', 'wear nexus spear']);
  });

  it('leaves another monster to the base kit', () => {
    const pack = [
      worn('lifestealer', WEAPON_HAND),
      worn('plate boots', 'Feet'),
      carried('nexus spear')
    ];
    make().onCharacter(fighting('big sandworm', pack), false);
    expect(sent).toEqual([]);
  });

  it('sends nothing with the switch off, or off an unread pack', () => {
    const pack = [carried('plate boots'), carried('lifestealer')];
    make(gear({ enabled: false })).onCharacter(standing(pack), false);
    const unread = standing(pack);
    make().onCharacter({ ...unread, inventory: { ...unread.inventory, listedAt: null } }, false);
    expect(sent).toEqual([]);
  });

  /* The retry floor: a `wear` the server swallowed is not resent per line. */
  it('does not repeat a command on every status line', () => {
    const manager = make();
    const state = standing([carried('plate boots'), carried('lifestealer')]);
    manager.onCharacter(state, false);
    manager.onCharacter(state, false);
    expect(sent).toEqual(['wear lifestealer', 'wear plate boots']);
  });

  /*
   * And the floor is the *situation's*, not the clock's: a character that
   * fights, walks and fights again inside half a minute must not have the
   * second swap refused by the first one's retry floor.
   */
  it('sends again when the situation changes back inside the retry floor', () => {
    const manager = make();
    const pack = [
      worn('plate boots', 'Feet'),
      worn('lifestealer', WEAPON_HAND),
      carried('brown leather boots')
    ];
    manager.onCharacter(standing(pack), true);
    expect(sent).toEqual(['wear brown leather boots']);
    // Now walking with the leather boots on, and the base wants the plate back.
    const after = [
      worn('brown leather boots', 'Feet'),
      worn('lifestealer', WEAPON_HAND),
      carried('plate boots')
    ];
    manager.onCharacter(standing(after), false);
    expect(sent).toEqual(['wear brown leather boots', 'wear plate boots']);
  });

  it('says what a set names and the pack does not hold, once', () => {
    const manager = make();
    const state = standing([carried('lifestealer')]);
    manager.onCharacter(state, false);
    manager.onCharacter(state, false);
    expect(notices.filter((line) => line.includes('plate boots'))).toHaveLength(1);
  });
});

/*
 * MegaMUD's backstab weapon as a set (todo 02). A `wear` breaks stealth
 * (`EquipCommand.cs:138,165`), so the set goes out in the walker's band, where
 * the queue keeps it ahead of the `sn` the step asks for next.
 */
describe('the backstab set', () => {
  const withStab = gear({
    sets: [...SETS, { name: 'Backstab', when: 'backstab', mob: '', wear: ['nexus spear'] }]
  });
  const armed = [worn('plate boots', 'Feet'), worn('lifestealer', WEAPON_HAND)];

  it('is worn between fights while the opener is a backstab, ahead of the step', () => {
    const offered = vi.spyOn(queue, 'enqueue');
    const pack = [...armed, carried('nexus spear')];
    make(withStab).onCharacter(standing(pack), false);
    expect(sent).toEqual([]);
    make(withStab, { opensWithBackstab: () => true }).beforeStep(standing(pack));
    expect(sent).toEqual(['wear nexus spear']);
    expect(offered.mock.calls.map(([intent]) => intent.priority)).toEqual(['movement']);
  });

  it('asks with the set’s own weapons, and walks in the moving set on a no', () => {
    const asked: (readonly string[])[] = [];
    const opens = (weapons: readonly string[]): boolean => {
      asked.push(weapons);
      return false;
    };
    const pack = [...armed, carried('nexus spear'), carried('brown leather boots')];
    make(withStab, { opensWithBackstab: opens }).beforeStep(standing(pack));
    expect(asked).toEqual([['nexus spear']]);
    expect(sent).toEqual(['wear brown leather boots']);
  });

  it('gives way to the fighting kit once the backstab has started the fight', () => {
    const manager = make(withStab, { opensWithBackstab: () => true });
    const stabbing = [worn('plate boots', 'Feet'), worn('nexus spear', WEAPON_HAND)];
    manager.onCharacter(standing([...stabbing, carried('lifestealer')]), false);
    expect(sent).toEqual([]);
    manager.onCharacter(fighting('big sandworm', [...stabbing, carried('lifestealer')]), false);
    expect(sent).toEqual(['wear lifestealer']);
  });
});

describe('using an item between rounds', () => {
  const offRound = (over: Partial<GearConfig['offRound']> = {}): GearConfig =>
    gear({ offRound: { item: 'nexus spear', everyRounds: 1, ...over } });

  const pack = (): CarriedItem[] => [
    worn('golden chalice', OFF_HAND),
    worn('lifestealer', WEAPON_HAND),
    carried('nexus spear')
  ];

  it('sends the whole dance on the round beat', () => {
    make(offRound()).round(fighting('nasty sandworm', pack()));
    expect(sent).toEqual([
      'remove golden chalice',
      'wear nexus spear',
      'use nexus spear nasty sandworm',
      'wear lifestealer',
      'wear golden chalice'
    ]);
  });

  it('counts rounds rather than status lines', () => {
    const manager = make(offRound({ everyRounds: 3 }));
    const state = fighting('nasty sandworm', pack());
    manager.round(state);
    manager.round(state);
    expect(sent).toEqual([]);
    manager.round(state);
    expect(sent.at(2)).toBe('use nexus spear nasty sandworm');
  });

  it('sends nothing at 0 rounds, with no item, or with nothing to aim at', () => {
    make(offRound({ everyRounds: 0 })).round(fighting('nasty sandworm', pack()));
    make(offRound({ item: '' })).round(fighting('nasty sandworm', pack()));
    make(offRound()).round(fighting(null, pack()));
    expect(sent).toEqual([]);
  });

  /* The wall-clock floor: rounds arriving faster than the dance can be sent. */
  it('will not queue a second dance behind the first', () => {
    const manager = make(offRound());
    const state = fighting('nasty sandworm', pack());
    manager.round(state);
    const first = sent.length;
    manager.round(state);
    expect(sent).toHaveLength(first);
  });
});

/*
 * The weapon put in hand for a monster the hand cannot hurt (todo 46): sent
 * with no gear sets switched on, and the old weapon back once the fight it
 * was for is over, not on the line before that fight opens.
 */
describe('the weapon that can hurt the monster', () => {
  const off = gear({ enabled: false, sets: [] });
  const golem: Partial<CharacterState> = {
    room: {
      ...structuredClone(EMPTY_CHARACTER).room,
      occupants: [
        classifyOccupant('stone golem', { players: new Set<string>(), mob: () => undefined })
      ]
    }
  };

  it('wields it with the sets off, and wields the old weapon again after the fight', () => {
    const manager = make(off);
    const before = [worn('club', WEAPON_HAND), carried('golden pike')];
    manager.wieldFor(standing(before, golem), 'golden pike', 'stone golem');
    vi.advanceTimersByTime(500);
    expect(sent).toEqual(['wear golden pike']);

    const holding = [carried('club'), worn('golden pike', WEAPON_HAND)];
    // The line before the fight opens sends nothing back.
    manager.onCharacter(standing(holding, golem), false);
    manager.onCharacter(fighting('stone golem', holding), false);
    vi.advanceTimersByTime(500);
    expect(sent).toEqual(['wear golden pike']);

    // Positive control: the fight ends and the club goes back in hand.
    manager.onCharacter(standing(holding), false);
    vi.advanceTimersByTime(500);
    expect(sent).toEqual(['wear golden pike', 'wear club']);
  });

  /* Todo 42: a fight came while a bless weapon was in hand for its `use`. */
  it('puts back the weapon a bless swap would have, not the bless weapon', () => {
    const yieldSwap = vi.fn(() => 'club');
    const manager = make(off, { yieldSwap });
    const blessing = [
      carried('club'),
      worn('shimmering longsword', WEAPON_HAND),
      carried('golden pike')
    ];
    manager.wieldFor(standing(blessing, golem), 'golden pike', 'stone golem');
    vi.advanceTimersByTime(500);
    expect(sent).toEqual(['wear golden pike']);
    expect(yieldSwap).toHaveBeenCalledTimes(1);

    const holding = [
      carried('club'),
      carried('shimmering longsword'),
      worn('golden pike', WEAPON_HAND)
    ];
    manager.onCharacter(fighting('stone golem', holding), false);
    manager.onCharacter(standing(holding), false);
    vi.advanceTimersByTime(500);
    expect(sent).toEqual(['wear golden pike', 'wear club']);
  });

  it('wields the old weapon again when the monster is gone with no fight', () => {
    const manager = make(off);
    manager.wieldFor(
      standing([worn('club', WEAPON_HAND), carried('golden pike')], golem),
      'golden pike',
      'stone golem'
    );
    const holding = [carried('club'), worn('golden pike', WEAPON_HAND)];
    manager.onCharacter(standing(holding, golem), false);
    vi.advanceTimersByTime(500);
    expect(sent).toEqual(['wear golden pike']);

    manager.onCharacter(standing(holding), false);
    vi.advanceTimersByTime(500);
    expect(sent).toEqual(['wear golden pike', 'wear club']);
  });
});

/*
 * Todo 69: the armour the room calls for. A desert room casting fire for 20 a
 * round, a fire-resisting tunic in the pack and a plain one on.
 */
describe('the armour the room calls for', () => {
  const RESIST_FIRE = 5;
  const TUNICS: Record<string, { fire: number; ac: number }> = {
    'leather tunic': { fire: 0, ac: 20 },
    'skirts of flame': { fire: 25, ac: 20 },
    chainmail: { fire: 0, ac: 20 }
  };
  const placeSources = (fire: number): Partial<EquipmentSources> => ({
    slotOf: (name) => (name in TUNICS ? 'Torso' : (SLOTS[name] ?? null)),
    exposureAt: (room) => (room === '1/2' ? { fire } : {}),
    placeItem: (item) => {
      const row = TUNICS[item.name];
      return row === undefined
        ? null
        : {
            name: item.name,
            slot: 'torso',
            equipped: item.equipped,
            abilities: [[RESIST_FIRE, row.fire]],
            armour: { ac: row.ac, dr: 0 }
          };
    }
  });
  const at = (map: number, number: number, items: CarriedItem[]): CharacterState => {
    const state = standing(items);
    return { ...state, room: { ...state.room, map, number } };
  };
  const noSets = gear({ sets: [] });

  it('wears the resisting tunic in the room and the old one back outside it', () => {
    const manager = make(noSets, placeSources(20));
    manager.onCharacter(
      at(1, 2, [worn('leather tunic', 'Torso'), carried('skirts of flame')]),
      false
    );
    expect(sent).toEqual(['wear skirts of flame']);
    manager.onCharacter(
      at(1, 3, [carried('leather tunic'), worn('skirts of flame', 'Torso')]),
      false
    );
    expect(sent).toEqual(['wear skirts of flame', 'wear leather tunic']);
  });

  it('keeps the resisting tunic on while it stands in the room', () => {
    const manager = make(noSets, placeSources(20));
    manager.onCharacter(
      at(1, 2, [worn('leather tunic', 'Torso'), carried('skirts of flame')]),
      false
    );
    clock += 60_000;
    manager.onCharacter(
      at(1, 2, [carried('leather tunic'), worn('skirts of flame', 'Torso')]),
      false
    );
    expect(sent).toEqual(['wear skirts of flame']);
  });

  // The first test is the positive control: the same pack in the same room swaps at 20 a round.
  it('leaves the tunic alone where it saves less than the floor', () => {
    make(noSets, placeSources(4)).onCharacter(
      at(1, 2, [worn('leather tunic', 'Torso'), carried('skirts of flame')]),
      false
    );
    expect(sent).toEqual([]);
  });

  it('gives way to a set the player wrote for the slot', () => {
    const sets: GearSet[] = [{ name: 'Fight', when: 'fighting', mob: '', wear: ['leather tunic'] }];
    const state = {
      ...at(1, 2, [worn('leather tunic', 'Torso'), carried('skirts of flame')]),
      inCombat: true
    };
    make(gear({ sets }), placeSources(20)).onCharacter(state, false);
    expect(sent).toEqual([]);
  });

  it('dresses for the room with gear sets off, and not with its own switch off', () => {
    const pack = [worn('leather tunic', 'Torso'), carried('skirts of flame')];
    make(gear({ enabled: false, sets: [] }), placeSources(20)).onCharacter(at(1, 2, pack), false);
    expect(sent).toEqual(['wear skirts of flame']);
    sent.length = 0;
    make(gear({ enabled: false, sets: [], resists: false }), placeSources(20)).onCharacter(
      at(1, 2, pack),
      false
    );
    expect(sent).toEqual([]);
  });

  it('forgets a replaced tunic the pack no longer holds', () => {
    const manager = make(noSets, placeSources(20));
    manager.onCharacter(
      at(1, 2, [worn('leather tunic', 'Torso'), carried('skirts of flame')]),
      false
    );
    expect(sent).toEqual(['wear skirts of flame']);
    // Sold while dressed: nothing to put back, and nothing said missing.
    manager.onCharacter(at(1, 3, [worn('skirts of flame', 'Torso')]), false);
    expect(sent).toEqual(['wear skirts of flame']);
    expect(notices.filter((line) => line.includes('leather tunic'))).toEqual([]);
  });

  it('puts back what someone else wore over the resisting tunic, not what it replaced', () => {
    const manager = make(noSets, placeSources(20));
    manager.onCharacter(
      at(1, 2, [worn('leather tunic', 'Torso'), carried('skirts of flame')]),
      false
    );
    // Better gear off the floor (todo 77) went on in its place, then the room was left.
    manager.onCharacter(
      at(1, 2, [carried('leather tunic'), carried('skirts of flame'), worn('chainmail', 'Torso')]),
      false
    );
    manager.onCharacter(
      at(1, 3, [carried('leather tunic'), worn('skirts of flame', 'Torso'), carried('chainmail')]),
      false
    );
    expect(sent.at(-1)).toBe('wear chainmail');
  });
});
