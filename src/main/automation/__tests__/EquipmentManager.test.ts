import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EquipmentManager, type EquipmentSources } from '../EquipmentManager';
import { CommandQueue } from './../CommandQueue';
import { EMPTY_CHARACTER, type CarriedItem, type CharacterState } from '../../../shared/character';
import { DEFAULT_CONFIG, type AutomationConfig, type GearConfig } from '../../../shared/config';
import { wireItem } from '../../../shared/entities';
import { OFF_HAND, WEAPON_HAND } from '../../../shared/items';
import type { GearSet } from '../../../shared/gear';

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
