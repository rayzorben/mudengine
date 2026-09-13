import { describe, expect, it } from 'vitest';

import {
  type SpotCharacter,
  compareSpots,
  estimateSpot,
  respawnSeconds,
  type HuntingConstants,
  type HuntingSpot,
  type SpotInput
} from '../hunting';
import { DEFAULT_INTERNAL } from '../internal';

const C: HuntingConstants = DEFAULT_INTERNAL.tuning.hunting;

/*
 * `Room.GetDelayInSeconds`: minutes, except an Arena room and a negative
 * figure are seconds. Then GreaterMUD's regen adds thirty seconds to the
 * elapsed time before comparing (`RegenSlot.cs:33`), so its lairs come back
 * sooner than the column says — measured 18–20s in a `Delay=1` lair.
 */
describe('the respawn clock', () => {
  it('reads minutes on MajorMUD, and thirty seconds sooner on GreaterMUD', () => {
    expect(respawnSeconds(2, 'majormud', C)).toBe(120);
    expect(respawnSeconds(2, 'greatermud', C)).toBe(90);
    expect(respawnSeconds(1, 'greatermud', C)).toBe(30);
  });

  it('reads a negative figure and an arena as seconds', () => {
    expect(respawnSeconds(-45, 'majormud', C)).toBe(45);
    expect(respawnSeconds(45, 'majormud', C, true)).toBe(45);
    expect(respawnSeconds(-10, 'greatermud', C)).toBe(0);
  });

  it('states no clock for a room that states none', () => {
    expect(respawnSeconds(null, 'greatermud', C)).toBeNull();
    expect(respawnSeconds(0, 'greatermud', C)).toBeNull();
  });
});

const singles = (over: Partial<SpotInput> = {}): SpotInput => ({
  rooms: 1,
  spawns: 1,
  mobs: [{ name: 'mutant', experience: 225, rounds: 6, perRound: 10 }],
  respawnSeconds: 30,
  loopSteps: 0,
  character: {
    hpMax: 289,
    restingHealthPerTick: 24,
    passiveHealthPerTick: 8,
    backstab: false,
    // A melee character: no round spell configured, so the cycle pays no mana
    // and the estimate is the one it always was.
    manaPerRound: null,
    manaMax: null,
    meditatingManaPerTick: null,
    passiveManaPerTick: null
  },
  ...over
});

describe('what a spot pays', () => {
  it('folds a kill, its rest and the wait for the respawn into one cycle', () => {
    const e = estimateSpot(singles(), C);
    // Six rounds of five seconds and the kill's overhead.
    expect(e.combatSeconds).toBeCloseTo(6 * 5 + 1.5, 5);
    // Sixty hit points taken, a little regained standing, three resting ticks.
    expect(e.damagePerRoom).toBe(60);
    expect(e.restSeconds).toBe(45);
    // Slower than the clock, so no waiting; the rate is the cycle's.
    expect(e.waitSeconds).toBe(0);
    expect(e.cycleSeconds).toBeCloseTo(31.5 + 45, 5);
    expect(e.expPerHour).toBeCloseTo((225 * 3600) / 76.5, 3);
    expect(e.ceilingPerHour).toBeCloseTo((225 * 3600) / 30, 3);
    expect(e.deadly).toBe(false);
    expect(e.unknown).toEqual([]);
  });

  /* The reviewer's point: a backstabber wants singles, and the arithmetic says why. */
  it('credits the opener on every kill in a room of singles, once a pack', () => {
    const alone = estimateSpot(
      singles({ character: { ...singles().character, backstab: true } }),
      C
    );
    // Six rounds becomes one opener round and two more.
    expect(alone.roundsPerKill).toBe(3);
    const pack = estimateSpot(
      singles({ spawns: 3, character: { ...singles().character, backstab: true } }),
      C
    );
    // The first of three is opened; the other two are plain.
    expect(pack.roundsPerKill).toBeCloseTo((3 + 6 + 6) / 3, 5);
  });

  it('prices a pack ramping down: the rest keep swinging while the first dies', () => {
    const pack = estimateSpot(singles({ spawns: 3 }), C);
    // 10 hp a round × 6 rounds × (3 + 2 + 1) monsters still up.
    expect(pack.damagePerRoom).toBe(10 * 6 * 6);
    expect(pack.expPerCycle).toBe(225 * 3);
  });

  it('waits for the clock when the cycle is faster than the respawn', () => {
    const e = estimateSpot(singles({ respawnSeconds: 300 }), C);
    expect(e.waitSeconds).toBeCloseTo(300 - 76.5, 5);
    expect(e.expPerHour).toBeCloseTo((225 * 3600) / 300, 3);
  });

  it('names what it could not finish, and never zeroes it', () => {
    const e = estimateSpot(
      singles({
        respawnSeconds: null,
        character: { ...singles().character, restingHealthPerTick: null, hpMax: null }
      }),
      C
    );
    expect(e.expPerHour).toBeNull();
    expect(e.ceilingPerHour).toBeNull();
    expect(e.unknown).toEqual(['respawn', 'health', 'rest']);
    // What it could work out, it did.
    expect(e.combatSeconds).toBeCloseTo(31.5, 5);
    expect(e.damagePerRoom).toBe(60);
  });

  it('calls a room that takes the whole bar deadly, and rates it nothing', () => {
    const e = estimateSpot(
      singles({ mobs: [{ name: 'dragon', experience: 50_000, rounds: 20, perRound: 30 }] }),
      C
    );
    expect(e.damagePerRoom).toBe(600);
    expect(e.deadly).toBe(true);
    expect(e.expPerHour).toBeNull();
    expect(e.ceilingPerHour).not.toBeNull();
  });

  it('spreads a loop over its rooms and walks between them', () => {
    const e = estimateSpot(singles({ rooms: 4, loopSteps: 12 }), C);
    expect(e.walkSeconds).toBeCloseTo(12 * 1.25, 5);
    expect(e.expPerCycle).toBe(225 * 4);
    expect(e.combatSeconds).toBeCloseTo(4 * 31.5, 5);
  });
});

describe('the order the reader wants', () => {
  const spot = (
    key: string,
    rate: number | null,
    ceiling: number | null,
    deadly = false
  ): HuntingSpot => ({
    key,
    mobs: [],
    clock: 'delay',
    respawnSeconds: 30,
    spawns: 1,
    rooms: [{ id: '1/1', map: 1, room: 1, name: 'Here', steps: 3 }],
    roomCount: 1,
    loopSteps: 0,
    estimate: {
      expPerHour: rate,
      ceilingPerHour: ceiling,
      expPerCycle: null,
      cycleSeconds: null,
      combatSeconds: null,
      restSeconds: null,
      meditateSeconds: null,
      walkSeconds: 0,
      waitSeconds: null,
      damagePerRoom: null,
      damageShare: null,
      roundsPerKill: null,
      deadly,
      unknown: []
    }
  });

  it('puts a known rate first, an unknown one by its ceiling after, and deadly last', () => {
    const ordered = [
      spot('deadly-rich', null, 9_000_000, true),
      spot('unknown-high', null, 500_000),
      spot('known-low', 20_000, 50_000),
      spot('known-high', 100_000, 200_000),
      spot('unknown-low', null, 40_000)
    ].sort(compareSpots);
    expect(ordered.map((s) => s.key)).toEqual([
      'known-high',
      'known-low',
      'unknown-high',
      'unknown-low',
      'deadly-rich'
    ]);
  });

  /*
   * A ceiling is a bound, not an estimate (todo 108): a single 500-point
   * monster on a one-hour clock outranked eight rooms of sewer monsters whose
   * rooms carry no clock. Among unknown rates, what one sweep earns decides.
   */
  it('orders unknown rates by what one sweep earns before the ceiling', () => {
    const sweep = (key: string, cycle: number | null, ceiling: number | null): HuntingSpot => {
      const s = spot(key, null, ceiling);
      return { ...s, estimate: { ...s.estimate, expPerCycle: cycle } };
    };
    const ordered = [
      sweep('troll', 500, 500),
      sweep('sewers', 1000, null),
      sweep('priest', 5, 5)
    ].sort(compareSpots);
    expect(ordered.map((s) => s.key)).toEqual(['sewers', 'troll', 'priest']);
  });
});

/*
 * The caster's half of the cycle (todo 26, 2026-09-12).
 *
 * Todo 05 left it out and named todo 09 as the prerequisite, which has since
 * landed. A melee cycle is bounded by the health it loses and the time to get
 * it back; a caster's is bounded by the mana it spends and the time to
 * meditate it back — which is the reviewer's *cluster, room-spell, then sit*
 * play priced rather than written in.
 */
describe("a caster's cycle", () => {
  const caster = (over: Partial<SpotCharacter> = {}): Partial<SpotInput> => ({
    character: {
      hpMax: 289,
      restingHealthPerTick: 24,
      passiveHealthPerTick: 8,
      backstab: false,
      manaPerRound: 6,
      manaMax: 120,
      // Meditating is NOT resting tripled: `TimedEventManager` gives a resting
      // character `HPRegen * 3` and a meditating one `GetBaseMARegen()` flat.
      meditatingManaPerTick: 9,
      passiveManaPerTick: 9,
      ...over
    }
  });

  it('costs a melee character nothing, to the second', () => {
    const plain = estimateSpot(singles(), C);
    expect(plain.meditateSeconds).toBe(0);
  });

  it('pays for the mana a round spends', () => {
    const spent = estimateSpot(singles(caster()), C);
    expect(spent.meditateSeconds).toBeGreaterThan(0);
  });

  /* And that time is in the cycle, so the rate falls. */
  it('is slower than the same room fought with a blade', () => {
    const melee = estimateSpot(singles(), C);
    const casting = estimateSpot(singles(caster()), C);
    expect(casting.cycleSeconds ?? 0).toBeGreaterThanOrEqual(melee.cycleSeconds ?? 0);
  });

  /*
   * What standing regains is taken off first, exactly as for health: a cheap
   * spell in a slow room costs no sitting at all.
   */
  it('pays nothing where standing regains it all', () => {
    const cheap = estimateSpot(singles(caster({ manaPerRound: 0.1 })), C);
    expect(cheap.meditateSeconds).toBe(0);
  });

  /* An unknown rate is named, never zeroed — the standing rule. */
  it('names the pool as unknown rather than pricing the cycle free', () => {
    const unread = estimateSpot(singles(caster({ meditatingManaPerTick: null })), C);
    expect(unread.unknown).toContain('mana');
    expect(unread.expPerHour).toBeNull();
  });
});
