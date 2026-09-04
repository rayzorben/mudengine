import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AutoLight } from '../AutoLight';
import { CommandQueue } from '../CommandQueue';
import { DEFAULT_CONFIG, type AutomationConfig, type MovementConfig } from '../../../shared/config';
import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';
import { domainOf, type Block, type BlockType } from '../../../shared/blocks';
import { wireItem, type ItemEntity } from '../../../shared/entities';
import type { SafetyDecision } from '../../../shared/automation';
import { carriedLights, sightOf, wornVision } from '../../../shared/light';

const automation: AutomationConfig = {
  ...DEFAULT_CONFIG.automation,
  pacing: { window: 8, minGapMs: 0, ackTimeoutMs: 1000 }
};

const movement = (over: Partial<MovementConfig> = {}): MovementConfig => ({
  ...DEFAULT_CONFIG.automation.movement,
  ...over
});

/** The realm's torch: a light with reach 100. */
function torch(over: Partial<ItemEntity> = {}): ItemEntity {
  return {
    ...wireItem('torch'),
    kind: 'light',
    abilities: [[54, 100]],
    ...over
  };
}

/** A character in the realm, with its sight worked out from the pack and `vision`. */
function character(
  items: ItemEntity[],
  vision = 0,
  over: Partial<CharacterState> = {}
): CharacterState {
  const base = structuredClone(EMPTY_CHARACTER);
  return {
    ...base,
    phase: 'in-game',
    race: 'Kang',
    room: { ...base.room, map: 1, number: 2147, name: 'Town Gates' },
    inventory: { ...base.inventory, items, wealth: 100 },
    sight: sightOf(vision + wornVision(items), carriedLights(items), true),
    ...over
  };
}

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

let sent: string[];
let decisions: SafetyDecision[];
let queue: CommandQueue;

beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  decisions = [];
  queue = new CommandQueue(automation, { send: (command) => sent.push(command) });
});

afterEach(() => {
  queue.dispose();
  vi.useRealTimers();
});

const make = (config: MovementConfig = movement(), enabled = true): AutoLight =>
  new AutoLight(config, enabled, queue, { decided: (decision) => decisions.push(decision) });
const drain = (): void => void vi.advanceTimersByTime(500);

describe('before a step into the dark', () => {
  it('lights a carried torch ahead of the step, and says so', () => {
    const auto = make();
    auto.beforeStep({ name: 'Sewer Tunnel', light: -175 }, character([torch()]));
    drain();
    expect(sent).toEqual(['light torch']);
    expect(decisions).toEqual([expect.objectContaining({ action: 'light', acted: true })]);
  });

  it('does nothing for a room the realm records no level for', () => {
    make().beforeStep({ name: 'Town Gates', light: undefined }, character([torch()]));
    drain();
    expect(sent).toEqual([]);
    expect(decisions).toEqual([]);
  });

  /* A Gaunt One sees a −175 room at 25: no torch, no decision to explain. */
  it('does nothing for a race that sees the room already', () => {
    make().beforeStep({ name: 'Dark Cave', light: -175 }, character([torch()], 200));
    drain();
    expect(sent).toEqual([]);
    expect(decisions).toEqual([]);
  });

  it('does nothing when a usable light is already lit', () => {
    make().beforeStep(
      { name: 'Sewer Tunnel', light: -175 },
      character([torch({ equipped: true, slot: 'Readied', charges: 62 })])
    );
    drain();
    expect(sent).toEqual([]);
  });

  /* The server refuses `light` over an occupied slot, a burnt-out torch included. */
  it('puts a spent light down before lighting the next', () => {
    make().beforeStep(
      { name: 'Sewer Tunnel', light: -175 },
      character([torch({ equipped: true, slot: 'Readied', charges: 0 }), torch()])
    );
    drain();
    expect(sent).toEqual(['remove torch', 'light torch']);
  });

  it('refuses out loud, once, when no carried light would make the room readable', () => {
    const auto = make();
    const state = character([torch()]);
    auto.beforeStep({ name: 'The Abyss', light: -999 }, state);
    auto.beforeStep({ name: 'The Abyss', light: -999 }, state);
    drain();
    expect(sent).toEqual([]);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ action: 'light', acted: false });
    expect(decisions[0]?.refused).toContain('torch (100)');
  });

  it('refuses out loud with nothing in the pack', () => {
    make().beforeStep({ name: 'Sewer Tunnel', light: -175 }, character([]));
    drain();
    expect(sent).toEqual([]);
    expect(decisions[0]).toMatchObject({ acted: false });
  });

  it('is a setting, and off it does nothing at all', () => {
    make(movement({ provideLight: false })).beforeStep(
      { name: 'Sewer Tunnel', light: -175 },
      character([torch()])
    );
    make(movement(), false).beforeStep({ name: 'Sewer Tunnel', light: -175 }, character([torch()]));
    drain();
    expect(sent).toEqual([]);
  });

  it('lights dim rooms only when asked to', () => {
    make().beforeStep({ name: 'Dim Hall', light: -50 }, character([torch()]));
    drain();
    expect(sent).toEqual([]);
    make(movement({ lightDimRooms: true })).beforeStep(
      { name: 'Dim Hall', light: -50 },
      character([torch()])
    );
    drain();
    expect(sent).toEqual(['light torch']);
  });
});

describe('on arriving somewhere dark', () => {
  it('lights when the server says the room is unreadable, once per room', () => {
    const auto = make();
    const base = character([torch()]);
    const dark: CharacterState = {
      ...base,
      room: { ...base.room, map: 1, number: 607, light: 'pitch black', lightLevel: -175 }
    };
    auto.onCharacter(dark, false);
    auto.onCharacter(dark, false);
    drain();
    expect(sent).toEqual(['light torch']);
  });

  it('reads the room again once the light is lit in a room the server would not describe', () => {
    const auto = make();
    const base = character([torch({ equipped: true, slot: 'Readied' })]);
    const dark: CharacterState = { ...base, room: { ...base.room, light: 'pitch black' } };
    auto.onBlock(block('user-equipped', { item: 'torch' }), dark);
    drain();
    expect(sent).toEqual(['l']);
  });

  it('tries the strongest usable light, as a guess, where the realm has no level', () => {
    const auto = make();
    const base = character([torch(), { ...torch({ name: 'moon-lamp' }), abilities: [[54, 200]] }]);
    const dark: CharacterState = {
      ...base,
      room: { ...base.room, map: null, number: null, light: 'very dark' }
    };
    auto.onCharacter(dark, false);
    drain();
    expect(sent).toEqual(['light moon-lamp']);
    expect(decisions[0]?.refused).toContain('moon-lamp');
  });
});

describe('putting the light out', () => {
  it('removes a lit torch in a lit room while nothing is walking', () => {
    const auto = make();
    const lit = character([torch({ equipped: true, slot: 'Readied', charges: 62 })]);
    auto.onCharacter(lit, false);
    drain();
    expect(sent).toEqual(['remove torch']);
  });

  it('never mid-route, never in the dark, never in a room it cannot place, and never when told not to', () => {
    const lit = character([torch({ equipped: true, slot: 'Readied', charges: 62 })]);
    make().onCharacter(lit, true);
    make().onCharacter({ ...lit, room: { ...lit.room, lightLevel: -175 } }, false);
    make().onCharacter({ ...lit, room: { ...lit.room, map: null, number: null } }, false);
    make(movement({ extinguishInLight: false })).onCharacter(lit, false);
    drain();
    expect(sent).toEqual([]);
  });

  it('leaves the torch lit for a race whose vision needs it in this room', () => {
    // −100 with vision 0 and torch 100 reads 0; without the torch, −100 is
    // barely visible — readable, so the torch comes out. With dim rooms on
    // it stays lit.
    const lit = character([torch({ equipped: true, slot: 'Readied', charges: 62 })]);
    make(movement({ lightDimRooms: true })).onCharacter(
      { ...lit, room: { ...lit.room, lightLevel: -100 } },
      false
    );
    drain();
    expect(sent).toEqual([]);
  });
});

describe('not saying the same thing twice', () => {
  /*
   * Found by review, reproduced: only the refusal branch deduplicated, so a
   * dark room the client could not *place* — where there is no room key to
   * compare — asked for the same torch on every status line, in the movement
   * band, for as long as the character stood there.
   */
  it('asks once for a dark room it cannot place, not once per status line', () => {
    const auto = make();
    const base = character([torch()]);
    const lost: CharacterState = {
      ...base,
      room: { ...base.room, map: null, number: null, light: 'pitch black' }
    };
    for (let line = 0; line < 4; line += 1) auto.onCharacter(lost, false);
    drain();
    expect(sent).toEqual(['light torch']);
  });

  /*
   * And the other half: a room left is a room whose memory goes with it.
   * `arrivalLitIn` was a single slot cleared only by a new connection, so
   * walking out of a dark room and back in by a typed direction found it still
   * set and did nothing at all — no light, and nothing in the trace.
   */
  it('lights again on returning to a dark room after a lit one', () => {
    const auto = make();
    const base = character([torch()]);
    const dark: CharacterState = {
      ...base,
      room: { ...base.room, map: 1, number: 607, light: 'pitch black', lightLevel: -175 }
    };
    const lit: CharacterState = {
      ...base,
      room: { ...base.room, map: 1, number: 608, light: null, lightLevel: 0 }
    };
    auto.onCharacter(dark, false);
    drain();
    expect(sent).toEqual(['light torch']);

    auto.onCharacter(lit, false);
    drain();
    auto.onCharacter(dark, false);
    drain();
    expect(sent.filter((command) => command === 'light torch')).toHaveLength(2);
  });
});

describe('what it stands down for', () => {
  /* Every module that spends a command in a crisis yields to the escape. */
  it('lights nothing while the character is running away', () => {
    const auto = new AutoLight(movement(), true, queue, {
      decided: (decision) => decisions.push(decision),
      escaping: () => true
    });
    auto.beforeStep({ name: 'Sewer Tunnel', light: -175 }, character([torch()]));
    drain();
    expect(sent).toEqual([]);
    expect(decisions).toEqual([]);
  });

  /*
   * The server has just said the room is dark and the realm records no level
   * for it. Pricing the absent column as *lit* would let missing data outrank
   * the wire, which is the one direction this client never reads it.
   */
  it('does not let an absent realm level outrank the server saying it is dark', () => {
    const auto = make();
    const base = character([torch()]);
    const dark: CharacterState = {
      ...base,
      room: { ...base.room, map: 1, number: 999, light: 'pitch black' }
    };
    auto.onCharacter(dark, false);
    drain();
    expect(sent).toEqual(['light torch']);
  });
});
