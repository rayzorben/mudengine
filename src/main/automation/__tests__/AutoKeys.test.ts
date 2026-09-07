import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AutoKeys, type KeyedWay, type KeySources } from '../AutoKeys';
import { CommandQueue } from '../CommandQueue';
import { DEFAULT_CONFIG, type AutomationConfig, type MovementConfig } from '../../../shared/config';
import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';
import { wireItem, type ItemEntity } from '../../../shared/entities';

const automation: AutomationConfig = {
  ...DEFAULT_CONFIG.automation,
  pacing: { window: 8, minGapMs: 0, ackTimeoutMs: 1000 }
};

const movement = (over: Partial<MovementConfig> = {}): MovementConfig => ({
  ...DEFAULT_CONFIG.automation.movement,
  ...over
});

/**
 * The reported room. `Crypt, Sealed Tomb` is 1/1309 and its north exit reads
 * `Key: 177`, which is `bone key`; sixty-six of them were on the floor.
 */
function inTheCrypt(over: Partial<CharacterState> = {}): CharacterState {
  const base = structuredClone(EMPTY_CHARACTER);
  return {
    ...base,
    phase: 'in-game',
    room: {
      ...base.room,
      map: 1,
      number: 1309,
      name: 'Crypt, Sealed Tomb',
      items: [floor('bone key', 66), floor('iron ring')]
    },
    // The pack has been listed and holds no key, which is the only state in
    // which the router calls that door a wall.
    inventory: { ...base.inventory, listedAt: 1, items: [], keys: [] },
    ...over
  };
}

function floor(name: string, count?: number): ItemEntity {
  return count === undefined ? wireItem(name) : wireItem(name, { count });
}

const BONE_KEY = 177;
const NORTH: KeyedWay = { keyId: BONE_KEY, direction: 'n', itemName: 'bone key' };

let sent: string[];
let said: string[];
let queue: CommandQueue;

beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  said = [];
  queue = new CommandQueue(automation, { send: (command) => sent.push(command) });
});

afterEach(() => {
  queue.dispose();
  vi.useRealTimers();
});

/** The realm's answers, stubbed exactly as `SessionManager` supplies them. */
function make(
  over: Partial<KeySources> = {},
  config: MovementConfig = movement(),
  enabled = true,
  events: { escaping?: () => boolean; busy?: () => boolean } = {}
): AutoKeys {
  const sources: KeySources = {
    ways: () => [NORTH],
    carried: (state) => ({
      keys: state.inventory.items.flatMap((item) => (item.name === 'bone key' ? [BONE_KEY] : [])),
      packKnown: state.inventory.listedAt !== null
    }),
    // The realm places the key and nothing else on that floor.
    idOf: (name) => (name === 'bone key' ? BONE_KEY : null),
    ...over
  };
  return new AutoKeys(config, enabled, queue, sources, { notice: (m) => said.push(m), ...events });
}

const drain = (): void => void vi.advanceTimersByTime(500);

describe('a key the way out needs, lying on this floor', () => {
  it('bends down for it, and says why', () => {
    make().onCharacter(inTheCrypt());
    drain();
    // By the realm's own name for it, not the listing's `66 bone key`: the
    // count is on the entry, and `get 66 bone key` is not a command.
    expect(sent).toEqual(['get bone key']);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('bone key');
  });

  it('asks once per room however often the floor is reprinted', () => {
    const auto = make();
    const here = inTheCrypt();
    auto.onCharacter(here);
    auto.onCharacter(here);
    drain();
    expect(sent).toEqual(['get bone key']);
  });

  /* A new room is a new floor and a new set of doors. */
  it('asks again in the next room that needs one', () => {
    const auto = make();
    auto.onCharacter(inTheCrypt());
    drain();
    const next = inTheCrypt();
    auto.onCharacter({ ...next, room: { ...next.room, number: 1310 } });
    drain();
    expect(sent).toEqual(['get bone key', 'get bone key']);
  });

  it('leaves it where it is once the pack holds one', () => {
    const here = inTheCrypt();
    make().onCharacter({
      ...here,
      inventory: { ...here.inventory, items: [wireItem('bone key')] }
    });
    drain();
    expect(sent).toEqual([]);
  });

  /*
   * The router's own refusal, and the reason this reads the pack through the
   * same statement: an unread pack does not say the key is missing, so it does
   * not say to bend down either.
   */
  it('decides nothing on a pack no listing has read', () => {
    const here = inTheCrypt();
    make().onCharacter({ ...here, inventory: { ...here.inventory, listedAt: null } });
    drain();
    expect(sent).toEqual([]);
  });

  it('leaves a floor with nothing the way out wants alone', () => {
    const here = inTheCrypt();
    make().onCharacter({ ...here, room: { ...here.room, items: [floor('iron ring')] } });
    drain();
    expect(sent).toEqual([]);
  });

  /*
   * The realm has three `iron key`s, so a floor naming one says which *kind*
   * of thing is lying there and not which row. `idOf` answers null, and a door
   * opened on a coin toss is the confidently wrong answer the router refuses
   * everywhere else — but the refusal is *said*, or the character stands on
   * the key beside the door it opens with nothing anywhere explaining why.
   */
  it('refuses a name the realm cannot settle to one row, out loud', () => {
    const auto = make({ idOf: () => null });
    const here = inTheCrypt();
    auto.onCharacter(here);
    drain();
    expect(sent).toEqual([]);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('bone key');
    // Once per room, however often the floor is reprinted.
    auto.onCharacter(here);
    drain();
    expect(said).toHaveLength(1);
  });

  /* And a floor that simply holds nothing relevant says nothing at all. */
  it('says nothing about a floor with no lookalike on it', () => {
    const here = inTheCrypt();
    make({ idOf: () => null }).onCharacter({
      ...here,
      room: { ...here.room, items: [floor('iron ring')] }
    });
    drain();
    expect(sent).toEqual([]);
    expect(said).toEqual([]);
  });

  /*
   * A move on the wire makes `room.items` the floor of the room being *left*,
   * and a marching walk sends its step from a band that outranks this — so a
   * `get` queued behind it is spent in the next room. Held rather than
   * refused: the next line after the walk is where this belongs.
   */
  it('waits while anything is moving the character, and acts once it stops', () => {
    let moving = true;
    const auto = make({}, movement(), true, { busy: () => moving });
    auto.onCharacter(inTheCrypt());
    drain();
    expect(sent).toEqual([]);
    moving = false;
    auto.onCharacter(inTheCrypt());
    drain();
    expect(sent).toEqual(['get bone key']);
  });

  it('stands down while an escape is in flight', () => {
    make({}, movement(), true, { escaping: () => true }).onCharacter(inTheCrypt());
    drain();
    expect(sent).toEqual([]);
  });

  it('does nothing where no exit of the room asks for anything', () => {
    make({ ways: () => [] }).onCharacter(inTheCrypt());
    drain();
    expect(sent).toEqual([]);
  });

  it('waits while the character is resting', () => {
    const here = inTheCrypt();
    make().onCharacter({ ...here, vitals: { ...here.vitals, resting: true } });
    drain();
    expect(sent).toEqual([]);
  });

  it('does nothing outside the realm', () => {
    make().onCharacter({ ...inTheCrypt(), phase: 'authenticating' });
    drain();
    expect(sent).toEqual([]);
  });

  it('does nothing with the switch off, or with automation off', () => {
    make({}, movement({ collectKeys: false })).onCharacter(inTheCrypt());
    make({}, movement(), false).onCharacter(inTheCrypt());
    drain();
    expect(sent).toEqual([]);
  });

  /*
   * Two doors, two keys, two `get`s — the coalesce key is the row and not the
   * module, or the second key would be swallowed by the first.
   */
  it('asks for each of two keys two doors want', () => {
    const here = inTheCrypt();
    make({
      ways: () => [NORTH, { keyId: 178, direction: 'e' }],
      idOf: (name) => (name === 'bone key' ? BONE_KEY : name === 'rusty key' ? 178 : null)
    }).onCharacter({
      ...here,
      room: { ...here.room, items: [floor('bone key', 66), floor('rusty key')] }
    });
    drain();
    expect(sent).toEqual(['get bone key', 'get rusty key']);
  });
});
