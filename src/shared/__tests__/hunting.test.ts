import { describe, expect, it } from 'vitest';

import {
  atSpeed,
  type MeasuredRate,
  withMeasured,
  spotRate,
  cashFloor,
  addFiller,
  huntLoop,
  lapClock,
  refillsOnEntry,
  compareSpots,
  estimateSpot,
  fightUnpriced,
  moveDelayMs,
  orderRing,
  respawnSeconds,
  sizeLoop,
  type FillerInput,
  type HuntingConstants,
  type HuntingRoom,
  type HuntingSpot,
  type SpotCharacter,
  type SpotInput,
  type SpotMob
} from '../hunting';
import { DEFAULT_INTERNAL } from '../internal';

const C: HuntingConstants = atSpeed(DEFAULT_INTERNAL.tuning.hunting, 1);

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

  /* `GameSpeed`: a realm at 5 runs every clock five times as fast, a stated `Delay` with them. */
  it('reads a stated delay at the realm’s speed', () => {
    const fast = atSpeed(DEFAULT_INTERNAL.tuning.hunting, 5);
    expect(fast).toMatchObject({ roundSeconds: 1, restTickSeconds: 3, roomRegenSeconds: 121 / 5 });
    expect(respawnSeconds(2, 'majormud', fast)).toBe(24);
    expect(respawnSeconds(2, 'greatermud', fast)).toBe(18);
  });

  it('states no clock for a room that states none', () => {
    expect(respawnSeconds(null, 'greatermud', C)).toBeNull();
    expect(respawnSeconds(0, 'majormud', C)).toBeNull();
  });

  /*
   * GreaterMUD refills a room with `Delay` 0 at its next regen: the pass for a
   * room stood in (`RegenTickTime`, 121s) and every entry (`Player.cs:782`).
   */
  it('reads a GreaterMUD delay of 0 as the regen pass', () => {
    expect(respawnSeconds(0, 'greatermud', C)).toBe(C.roomRegenSeconds);
  });

  it('puts no clock on a refilling stop, so the lap walks it every time', () => {
    const room = (name: string, number: number, respawnSeconds?: number) => ({
      id: `1/${number}`,
      map: 1,
      room: number,
      name,
      steps: 1,
      ...(respawnSeconds === undefined ? {} : { respawnSeconds })
    });
    const spot = {
      key: 'lair:1:80:',
      mobs: [{ name: 'cave bear' }],
      respawnSeconds: C.roomRegenSeconds,
      walk: [room('Small Cavern', 2156, 0), room('Dungeon, Entrance', 2152, 0)]
    } as unknown as HuntingSpot;
    const loop = huntLoop(spot, (key) => key);
    expect(loop.stops.map((stop) => stop.every)).toEqual([undefined, undefined]);
  });

  it('refills on entry only for a GreaterMUD delay of 0, and only on a lap of two stops or more', () => {
    expect(refillsOnEntry(0, 'greatermud')).toBe(true);
    expect(refillsOnEntry(1, 'greatermud')).toBe(false);
    expect(refillsOnEntry(0, 'majormud')).toBe(false);
    expect(lapClock(121, true, 1)).toBe(121);
    expect(lapClock(121, true, 2)).toBe(0);
    expect(lapClock(121, false, 2)).toBe(121);
  });
});

/*
 * `MoveCommand.cs:40`: `1100 + (Encum / MaxEnc)² × 2000`, floored at 1,000.
 * The two figures are the status line's `Encum:` pair; any other family, or
 * a pack nobody has weighed, prices the measured round rather than a formula
 * the client has not read off that server.
 */
describe('one step of a walk', () => {
  it('is the server’s own movement delay from the pack’s weight on GreaterMUD', () => {
    expect(moveDelayMs(0, 1000, 'greatermud', 1250)).toBe(1100);
    expect(moveDelayMs(500, 1000, 'greatermud', 1250)).toBe(1600);
    expect(moveDelayMs(1000, 1000, 'greatermud', 1250)).toBe(3100);
  });

  it('prices the measured round where the pack or the family is unknown', () => {
    expect(moveDelayMs(null, 1000, 'greatermud', 1250)).toBe(1250);
    expect(moveDelayMs(500, null, 'greatermud', 1250)).toBe(1250);
    expect(moveDelayMs(500, 1000, 'majormud', 1250)).toBe(1250);
    expect(moveDelayMs(500, 1000, null, 1250)).toBe(1250);
  });
});

const mutant = (over: Partial<SpotMob> = {}): SpotMob => ({
  name: 'mutant',
  experience: 225,
  copper: 0,
  rounds: 6,
  perRound: 10,
  nakedPerRound: 30,
  afflictions: [],
  regenSeconds: null,
  ...over
});

const melee: SpotCharacter = {
  hpMax: 289,
  restingHealthPerTick: 24,
  passiveHealthPerTick: 8,
  backstab: false,
  // A melee character: no round spell configured, so the cycle pays no mana
  // and the estimate is the one it always was.
  manaPerRound: null,
  manaMax: null,
  meditatingManaPerTick: null,
  passiveManaPerTick: null,
  stepMs: null,
  heal: null,
  poisonHoldsRest: false
};

const singles = (over: Partial<SpotInput> = {}): SpotInput => ({
  rooms: 1,
  spawns: 1,
  mobs: [mutant()],
  respawnSeconds: 30,
  loopSteps: 0,
  character: melee,
  filler: [],
  ...over
});

describe('what a spot pays', () => {
  it('folds a kill, its rest and the wait for the respawn into one cycle', () => {
    const e = estimateSpot(singles(), C);
    // Six rounds of five seconds and the kill's overhead.
    expect(e.combatSeconds).toBeCloseTo(6 * 5 + 1.5, 5);
    // Sixty hit points taken, 8.4 regained standing, and two resting ticks of
    // 24 each with half a standing tick's 8 beside it (`sittingPerSecond`).
    expect(e.damagePerRoom).toBe(60);
    expect(e.restSeconds).toBe(30);
    // Slower than the clock, so no waiting; the rate is the cycle's.
    expect(e.waitSeconds).toBe(0);
    expect(e.cycleSeconds).toBeCloseTo(31.5 + 30, 5);
    expect(e.expPerHour).toBeCloseTo((225 * 3600) / 61.5, 3);
    expect(e.ceilingPerHour).toBeCloseTo((225 * 3600) / 30, 3);
    expect(e.deadly).toBe(false);
    expect(e.costly).toBe(false);
    expect(e.trivial).toBe(false);
    expect(e.healCasts).toBe(0);
    expect(e.poisonSeconds).toBe(0);
    expect(e.unknown).toEqual([]);
  });

  /* Format 49: a kill's copper rides the same cycle as its exp, and ranks nothing. */
  it('pays copper a cycle and an hour on the cycle the exp is paid on', () => {
    const plain = estimateSpot(singles(), C);
    const thief = estimateSpot(singles({ mobs: [mutant({ copper: 50.5 })] }), C);
    expect(thief.copperPerCycle).toBeCloseTo(50.5, 5);
    expect(thief.copperPerHour).toBeCloseTo((50.5 * 3600) / thief.cycleSeconds!, 3);
    expect(thief.expPerHour).toBe(plain.expPerHour);
    expect(plain.copperPerHour).toBe(0);
  });

  /* todo 16: a fight run from pays nothing. */
  it('pays exp and copper only for the share of fights won', () => {
    const all = estimateSpot(singles({ mobs: [mutant({ copper: 50.5 })] }), C);
    const half = estimateSpot(singles({ mobs: [mutant({ copper: 50.5 })], wins: 0.5 }), C);
    expect(half.expPerCycle).toBeCloseTo(all.expPerCycle! / 2, 5);
    expect(half.copperPerCycle).toBeCloseTo(all.copperPerCycle! / 2, 5);
  });

  it("weighs a filler's copper at the share of laps it is found up", () => {
    const filler: FillerInput = {
      spawns: 1,
      mobs: [mutant({ copper: 100 })],
      respawnSeconds: 1_000_000,
      detourSteps: 0
    };
    const e = estimateSpot(singles({ filler: [filler] }), C);
    // The ring's mutant carries none; the filler's 100 is paid at its exp's share.
    expect(e.fillerExpPerCycle).toBeGreaterThan(0);
    expect(e.fillerExpPerCycle).toBeLessThan(225);
    expect(e.copperPerCycle).toBeCloseTo((e.fillerExpPerCycle * 100) / 225, 5);
  });

  it("says nothing of copper where the realm file predates monsters' coins", () => {
    const e = estimateSpot(singles({ mobs: [mutant({ copper: null })] }), C);
    expect(e.copperPerCycle).toBeNull();
    expect(e.copperPerHour).toBeNull();
    expect(e.expPerHour).not.toBeNull();
  });

  /* The reviewer's point: a backstabber wants singles, and the arithmetic says why. */
  it('credits the opener on every kill in a room of singles, once a pack', () => {
    const alone = estimateSpot(singles({ character: { ...melee, backstab: true } }), C);
    // Six rounds becomes one opener round and two more.
    expect(alone.roundsPerKill).toBe(3);
    const pack = estimateSpot(singles({ spawns: 3, character: { ...melee, backstab: true } }), C);
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
    expect(e.waitSeconds).toBeCloseTo(300 - 61.5, 5);
    expect(e.expPerHour).toBeCloseTo((225 * 3600) / 300, 3);
  });

  it('names what it could not finish, and never zeroes it', () => {
    const e = estimateSpot(
      singles({
        respawnSeconds: null,
        character: { ...melee, restingHealthPerTick: null, hpMax: null }
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
      singles({
        mobs: [mutant({ name: 'dragon', experience: 50_000, rounds: 20, perRound: 30 })]
      }),
      C
    );
    expect(e.damagePerRoom).toBe(600);
    expect(e.deadly).toBe(true);
    expect(e.costly).toBe(true);
    expect(e.expPerHour).toBeNull();
    expect(e.ceilingPerHour).not.toBeNull();
  });

  it('leaves deadly and costly to the run fight where the odds book ran it safe', () => {
    const input = singles({
      mobs: [mutant({ name: 'dragon', experience: 50_000, rounds: 20, perRound: 30 })]
    });
    const floor = estimateSpot(input, C);
    expect(floor.deadly).toBe(true);
    const ran = estimateSpot({ ...input, fightRun: true }, C);
    expect(ran.worstShareAtLeast).toBe(floor.worstShareAtLeast);
    expect(ran.deadly).toBe(false);
    expect(ran.costly).toBe(false);
    expect(ran.expPerHour).not.toBeNull();
  });

  it('spreads a loop over its rooms and walks between them', () => {
    const e = estimateSpot(singles({ rooms: 4, loopSteps: 12 }), C);
    expect(e.walkSeconds).toBeCloseTo(12 * 1.25, 5);
    expect(e.expPerCycle).toBe(225 * 4);
    expect(e.combatSeconds).toBeCloseTo(4 * 31.5, 5);
  });

  /* The pack's weight slows the whole loop, and the estimate says so (todo 00). */
  it('walks at the step the pack’s weight sets', () => {
    const heavy = estimateSpot(
      singles({ loopSteps: 12, character: { ...melee, stepMs: 2000 } }),
      C
    );
    expect(heavy.stepMs).toBe(2000);
    expect(heavy.walkSeconds).toBeCloseTo(24, 5);
    const light = estimateSpot(singles({ loopSteps: 12 }), C);
    expect(light.stepMs).toBe(C.stepMs);
    expect(heavy.expPerHour!).toBeLessThan(light.expPerHour!);
  });
});

/*
 * The two exclusions the survey makes before ranking (todo 00, 2026-09-13):
 * a room that costs more than `maxDamageShare` of the bar a cycle is a lair
 * whose rate is mostly resting, and one that could not take `trivialShare`
 * of the bar off an unarmoured character is beneath the level.
 */
/*
 * A row the realm gives a clock of its own is not on the room's clock (todo
 * 09, reported live): the Gravedigger is 1,500 points on an hour's
 * regeneration, and a lair holding it was priced as though it came back with
 * everything else in the room.
 */
describe('a monster on its own clock', () => {
  const boss = (over: Partial<SpotMob> = {}): SpotMob =>
    mutant({ name: 'gravedigger', experience: 1500, rounds: 20, ...over });

  it('pays only the share of cycles that finds it standing there', () => {
    const onTheRoomsClock = estimateSpot(singles({ mobs: [boss()] }), C);
    const onItsOwn = estimateSpot(singles({ mobs: [boss({ regenSeconds: 3600 })] }), C);
    expect(onTheRoomsClock.expPerHour).not.toBeNull();
    expect(onItsOwn.expPerHour).not.toBeNull();
    // A minute's cycle against an hour's regeneration: a fraction of what the
    // room's own clock would have promised, not the whole of it.
    expect(onItsOwn.expPerHour!).toBeLessThan(onTheRoomsClock.expPerHour! / 10);
  });

  it('counts whole where the cycle is longer than its clock', () => {
    const slow = singles({ respawnSeconds: 7200, mobs: [boss({ regenSeconds: 3600 })] });
    const plain = singles({ respawnSeconds: 7200, mobs: [boss()] });
    expect(estimateSpot(slow, C).expPerHour).toBe(estimateSpot(plain, C).expPerHour);
  });
});

describe('what is left out before the ranking', () => {
  /*
   * The survey's top row on Paradigm for a level-30 fighter was a lair of a
   * ghost, a shadowraith and a crimson mist: averaged, half the bar a room;
   * spawned one visit in three, a monster that takes it whole. The
   * exclusions read the worst the room can spawn, the rate the mean.
   */
  it('reads the worst spawn, not the mean, when deciding deadly and costly', () => {
    const e = estimateSpot(
      singles({
        mobs: [
          mutant({ name: 'ghost', experience: 1500, rounds: 5.6, perRound: 11.4 }),
          mutant({ name: 'crimson mist', experience: 300_000, rounds: 17.8, perRound: 40.3 }),
          mutant({ name: 'shadowraith', experience: 1200, rounds: 5.8, perRound: 9.3 })
        ]
      }),
      C
    );
    expect(e.damageShare!).toBeLessThan(1);
    expect(e.worstDamagePerRoom).toBeCloseTo(40.3 * 17.8, 5);
    expect(e.worstShare!).toBeGreaterThan(1);
    expect(e.deadly).toBe(true);
    expect(e.costly).toBe(true);
  });

  it('marks a room that costs more than the share as too dangerous, short of deadly', () => {
    // Two of them at 16 a round: 16 × 6 × (2 + 1) = 288 of a 289 bar — a hair short of deadly.
    const e = estimateSpot(singles({ spawns: 2, mobs: [mutant({ perRound: 16 })] }), C);
    expect(e.damagePerRoom).toBe(16 * 6 * 3);
    expect(e.deadly).toBe(false);
    expect(e.costly).toBe(true);
    // Still rated — the exclusion is the survey's, and the figure stays readable.
    expect(e.expPerHour).not.toBeNull();
  });

  it('marks a room that could not scratch an unarmoured character as beneath this level', () => {
    // Naked: 4 a round for 6 rounds is 24 hp, under a tenth of a 289 bar at 95%.
    const weak = estimateSpot(singles({ mobs: [mutant({ perRound: 1, nakedPerRound: 4 })] }), C);
    expect(weak.trivial).toBe(true);
    // Dressed, the same monster costs nothing; naked it would cost 180. Not trivial.
    const real = estimateSpot(singles({ mobs: [mutant({ perRound: 1, nakedPerRound: 30 })] }), C);
    expect(real.trivial).toBe(false);
  });

  it('marks nothing where the naked figure or the bar is unknown', () => {
    expect(estimateSpot(singles({ mobs: [mutant({ nakedPerRound: null })] }), C).trivial).toBe(
      false
    );
    expect(estimateSpot(singles({ character: { ...melee, hpMax: null } }), C).trivial).toBe(false);
  });

  /*
   * A level-one Mystic on a stock realm (2026-09-17), where the kill
   * arithmetic is not this family's: every spawn's rounds unknown, so neither
   * exclusion fired and the top of the list was ten bone warriors at 103 hp a
   * round against a 33 hp bar. The blows are known whether the rounds are or
   * not, and a kill takes at least the shortest one the model prices.
   */
  it('reads the blows alone where the rounds are unknown, as a floor', () => {
    const bar = { ...melee, hpMax: 33 };
    const warriors = estimateSpot(
      singles({ spawns: 10, character: bar, mobs: [mutant({ rounds: null, perRound: 103 })] }),
      C
    );
    expect(warriors.worstShare).toBeNull();
    expect(warriors.worstShareAtLeast!).toBeGreaterThan(1);
    expect(warriors.deadly).toBe(true);
    expect(warriors.costly).toBe(true);
    expect(warriors.unknown).toContain('rounds');
    // One at 10 a round: half a round is 5 of the 33, and the rest is not known.
    const thug = estimateSpot(
      singles({ character: bar, mobs: [mutant({ rounds: null, perRound: 10 })] }),
      C
    );
    expect(thug.worstDamageAtLeast).toBe(5);
    expect(thug.worstShareAtLeast).toBeCloseTo(5 / 33, 5);
    expect(thug.costly).toBe(false);
    expect(thug.expPerHour).toBeNull();
    // Where every spawn's rounds are known the floor is the exact figure.
    const priced = estimateSpot(singles(), C);
    expect(priced.worstDamageAtLeast).toBe(priced.worstDamagePerRoom);
  });

  it('calls a room that cannot hit anybody beneath this level, rounds known or not', () => {
    const e = estimateSpot(
      singles({ mobs: [mutant({ rounds: null, perRound: 0, nakedPerRound: 0 })] }),
      C
    );
    expect(e.trivial).toBe(true);
  });

  it('marks nothing beneath this level while one spawn is unfinished', () => {
    // A priced rat beside an unpriced one that can hit: not trivial, and the
    // exact cost waits for the second spawn's rounds.
    const e = estimateSpot(
      singles({ mobs: [mutant({ nakedPerRound: 4 }), mutant({ rounds: null, nakedPerRound: 4 })] }),
      C
    );
    expect(e.trivial).toBe(false);
    expect(e.worstShare).toBeNull();
    expect(e.worstShareAtLeast).not.toBeNull();
    // The rate is finished off the priced spawn, so it is ranked on the rate
    // and not counted among the fights nobody could price.
    expect(e.expPerHour).not.toBeNull();
    expect(fightUnpriced(e)).toBe(false);
  });
});

/*
 * Healing is a rest that costs a round and mana instead of sitting time, and
 * casting is not refused to a poisoned character where `rest` is. The cycle
 * takes whichever recovery is quicker.
 */
describe('recovering by casting', () => {
  const healer: SpotCharacter = {
    ...melee,
    // A caster's pool comes back at the standing rate while sitting too.
    meditatingManaPerTick: 9,
    passiveManaPerTick: 9,
    manaMax: 120,
    heal: { hpPerCast: 40, manaPerCast: 6 }
  };

  it('casts where two heals beat three resting ticks', () => {
    const e = estimateSpot(singles({ character: healer }), C);
    // 60 hp owed less what standing regains; two casts of 40 in ten seconds
    // against forty-five seconds of resting.
    expect(e.healCasts).toBe(2);
    expect(e.restSeconds).toBe(0);
    expect(e.cycleSeconds!).toBeLessThan(estimateSpot(singles(), C).cycleSeconds!);
  });

  it('rests where the heal’s mana would take longer to sit back than the rest', () => {
    const dear = { ...healer, heal: { hpPerCast: 10, manaPerCast: 200 } };
    const e = estimateSpot(singles({ character: dear }), C);
    expect(e.healCasts).toBe(0);
    expect(e.restSeconds).toBe(30);
  });

  it('costs a melee character nothing and casts nothing', () => {
    const e = estimateSpot(singles(), C);
    expect(e.healCasts).toBe(0);
    expect(e.meditateSeconds).toBe(0);
  });
});

/*
 * `RestCommand.cs:28` refuses a poisoned character. Where nothing this
 * character has lifts it, a lair that poisons stands the character for the
 * poison's stated length before the rest can begin; a poison of unstated
 * length makes the rate unknown, never free.
 */
describe('a lair that poisons', () => {
  const poisoner = mutant({ afflictions: [{ kind: 'poison', seconds: 90 }] });
  const unlifted: SpotCharacter = { ...melee, poisonHoldsRest: true };

  it('stands the character for the poison before the rest, and says how long', () => {
    const e = estimateSpot(singles({ mobs: [poisoner], character: unlifted }), C);
    expect(e.poisonSeconds).toBe(90);
    // The ninety seconds are in the cycle, and the three standing ticks in them
    // (every 30s, `DoHPTick`) take a rest tick off the 30s rest after.
    expect(e.restSeconds).toBe(15);
    expect(e.cycleSeconds).toBeCloseTo(31.5 + 90 + 15, 5);
    // Stood long enough, standing regains all that was owed and there is no rest.
    const long = mutant({ afflictions: [{ kind: 'poison', seconds: 600 }] });
    expect(estimateSpot(singles({ mobs: [long], character: unlifted }), C).restSeconds).toBe(0);
  });

  it('costs nothing where the character is immune or has a cure', () => {
    const e = estimateSpot(singles({ mobs: [poisoner] }), C);
    expect(e.poisonSeconds).toBe(0);
    expect(e.restSeconds).toBe(30);
  });

  it('names an unstated length rather than pricing it free', () => {
    const vague = mutant({ afflictions: [{ kind: 'poison', seconds: null }] });
    const e = estimateSpot(singles({ mobs: [vague], character: unlifted }), C);
    expect(e.unknown).toContain('poison');
    expect(e.expPerHour).toBeNull();
  });

  it('is walked round by a heal, which is not refused', () => {
    const healer: SpotCharacter = {
      ...unlifted,
      meditatingManaPerTick: 9,
      passiveManaPerTick: 9,
      manaMax: 120,
      heal: { hpPerCast: 40, manaPerCast: 6 }
    };
    const e = estimateSpot(singles({ mobs: [poisoner], character: healer }), C);
    expect(e.healCasts).toBe(2);
    expect(e.poisonSeconds).toBe(0);
  });

  it('does not wait where nothing needs recovering', () => {
    const scratch = mutant({ perRound: 0.1, afflictions: [{ kind: 'poison', seconds: 90 }] });
    const e = estimateSpot(singles({ mobs: [scratch], character: unlifted, loopSteps: 40 }), C);
    expect(e.poisonSeconds).toBe(0);
  });
});

/*
 * The loop is sized to the clock (todo 00): the rate climbs with every room
 * until the cycle is at least the respawn, and falls slowly after it, since
 * one more room is walked for a room that has not refilled.
 */
describe('how many rooms the loop visits', () => {
  it('takes the fewest rooms within tolerance of the best rate, once the clock is covered', () => {
    // A cycle of one room is 76.5s against a 300s clock: one room waits most of it.
    const size = (rooms: number): SpotInput =>
      singles({ rooms, loopSteps: 2 * rooms, respawnSeconds: 300 });
    const sized = sizeLoop(size, 8, C);
    const rates = [1, 2, 3, 4, 5, 6, 7, 8].map((k) => estimateSpot(size(k), C).expPerHour!);
    const best = Math.max(...rates);
    // No smaller loop reaches the tolerance, and this one does.
    expect(sized.estimate.expPerHour!).toBeGreaterThanOrEqual(best * (1 - C.sizeTolerance));
    for (const rate of rates.slice(0, sized.rooms - 1)) {
      expect(rate).toBeLessThan(best * (1 - C.sizeTolerance));
    }
    // And it no longer waits for the clock, which one room did.
    expect(sized.estimate.waitSeconds).toBe(0);
    expect(estimateSpot(size(1), C).waitSeconds!).toBeGreaterThan(0);
    expect(sized.rooms).toBeGreaterThan(1);
    expect(sized.rooms).toBeLessThan(8);
  });

  it('camps a single room where every further room costs more walk than it pays', () => {
    const sized = sizeLoop(
      (rooms) => singles({ rooms, loopSteps: rooms <= 1 ? 0 : 100 * rooms }),
      8,
      C
    );
    expect(sized.rooms).toBe(1);
  });

  it('takes every room offered where no size yields a rate', () => {
    const sized = sizeLoop(
      (rooms) => singles({ rooms, loopSteps: 2 * rooms, respawnSeconds: null }),
      5,
      C
    );
    expect(sized.rooms).toBe(5);
    expect(sized.estimate.expPerHour).toBeNull();
  });
});

/*
 * A filler is a clocked lair beside the ring, fought while the primary's
 * clock runs. Added one at a time while each raises the rate; a filler on a
 * slower clock than the cycle pays the share of visits that find it up.
 */
describe('filling the wait', () => {
  const rat: FillerInput = {
    spawns: 1,
    mobs: [mutant({ name: 'rat', experience: 40, rounds: 1, perRound: 1 })],
    respawnSeconds: 30,
    detourSteps: 2
  };

  it('adds a lair beside the ring while the cycle would otherwise wait', () => {
    const waiting = singles({ respawnSeconds: 300 });
    const before = estimateSpot(waiting, C);
    expect(before.waitSeconds!).toBeGreaterThan(0);
    const filled = addFiller(waiting, [rat, rat, rat], 8, C);
    expect(filled.taken.length).toBeGreaterThan(0);
    expect(filled.estimate.expPerHour!).toBeGreaterThan(before.expPerHour!);
    expect(filled.estimate.fillerExpPerCycle).toBeGreaterThan(0);
  });

  /*
   * The cave bear: one room on GreaterMUD's regen pass, refilled whenever a
   * player walks in. Standing there waits the pass out; stepping next door and
   * back re-enters it every lap, so the lair beside it is taken and the wait goes.
   */
  it('takes the room next door for a lair that refills on entry, and the wait goes', () => {
    const bear = singles({ respawnSeconds: C.roomRegenSeconds, refillsOnEntry: true });
    const camping = estimateSpot(bear, C);
    expect(camping.waitSeconds!).toBeGreaterThan(0);
    const filled = addFiller(
      bear,
      [{ ...rat, respawnSeconds: C.roomRegenSeconds, refillsOnEntry: true }],
      8,
      C
    );
    expect(filled.taken).toEqual([0]);
    expect(filled.estimate.waitSeconds).toBe(0);
    expect(filled.estimate.expPerHour!).toBeGreaterThan(camping.expPerHour!);
  });

  /* Todo 64: a loop short of its cash floor takes a lair that carries coin, at a cost in exp. */
  it('takes a coin-carrying lair under a cash floor, even where it costs exp', () => {
    const busy = singles();
    const thief: FillerInput = {
      ...rat,
      mobs: [mutant({ name: 'kobold thief', experience: 1, rounds: 3, perRound: 1, copper: 50.5 })],
      detourSteps: 10
    };
    expect(addFiller(busy, [thief], 8, C).taken).toEqual([]);
    const filled = addFiller(busy, [thief], 8, C, 1_000_000);
    expect(filled.taken).toEqual([0]);
    expect(filled.estimate.copperPerHour!).toBeGreaterThan(0);
    expect(filled.estimate.expPerHour!).toBeLessThan(estimateSpot(busy, C).expPerHour!);
  });

  it('adds nothing to a cycle already slower than its clock', () => {
    const busy = singles();
    expect(estimateSpot(busy, C).waitSeconds).toBe(0);
    expect(addFiller(busy, [rat], 8, C).taken).toEqual([]);
  });

  it('pays a slow filler only the share of visits that find it up', () => {
    const slow: FillerInput = { ...rat, respawnSeconds: 3000 };
    const e = estimateSpot(singles({ respawnSeconds: 300, filler: [slow] }), C);
    // The cycle is the 300s clock; a 3000s filler is up one visit in ten.
    expect(e.fillerExpPerCycle).toBeCloseTo(4, 5);
  });

  /*
   * And charges it at that share too. The loop a player walks turns aside for
   * a slow room only on the laps its clock has come round — `1,2,3,1,2,1,2,3`,
   * never room 3 every lap and empty on most of them.
   */
  it('walks and fights a slow filler only on the visits it is up', () => {
    const base = singles({ respawnSeconds: 300 });
    const bare = estimateSpot(base, C);
    const tenth: FillerInput = { ...rat, respawnSeconds: 3000 };
    const e = estimateSpot({ ...base, filler: [tenth] }, C);
    // Two steps of detour, walked one lap in ten.
    const step = (bare.stepMs * 2) / 1000;
    expect(e.walkSeconds - bare.walkSeconds).toBeCloseTo(step / 10, 5);
    // One round and one kill's overhead, fought one lap in ten.
    const fight = 1 * C.roundSeconds + C.killOverheadMs / 1000;
    expect(e.combatSeconds! - bare.combatSeconds!).toBeCloseTo(fight / 10, 5);
  });

  /*
   * A boss standing in a filler is on a clock of its own exactly as one in the
   * ring is. Weighing only the ring's rows left the whole failure this model
   * exists to end alive on the filler path — and `addFiller` picks candidates
   * by the rate they produce, so those were the rooms it reached for first.
   */
  it('weighs a filler’s own rows by their clocks, as it does the ring’s', () => {
    const boss = { name: 'gravedigger', experience: 3600, rounds: 1, perRound: 1 };
    const withClock: FillerInput = { ...rat, mobs: [mutant({ ...boss, regenSeconds: 3600 })] };
    const withNone: FillerInput = { ...rat, mobs: [mutant(boss)] };
    const base = singles({ respawnSeconds: 300 });
    const clocked = estimateSpot({ ...base, filler: [withClock] }, C);
    const free = estimateSpot({ ...base, filler: [withNone] }, C);
    // Visited every 300s against an hour's regeneration: a twelfth of it.
    expect(free.fillerExpPerCycle).toBeCloseTo(3600, 5);
    expect(clocked.fillerExpPerCycle).toBeCloseTo(300, 5);
  });

  /*
   * The ceiling is what the lair pays if every kill were free, so the cycle is
   * the clock itself — a filler still only pays the laps that clock allows.
   * Credited whole, the bound came out above the rate its own estimate called
   * reachable, which is not a bound.
   */
  it('keeps the ceiling a bound, with a filler credited at its own clock', () => {
    const slow: FillerInput = { ...rat, respawnSeconds: 3000 };
    const e = estimateSpot(singles({ respawnSeconds: 300, filler: [slow] }), C);
    expect(e.ceilingPerHour!).toBeGreaterThanOrEqual(e.expPerHour!);
    // 225 for the primary and a tenth of the filler's 40, every 300s.
    expect(e.ceilingPerHour).toBeCloseTo(((225 + 4) * 3600) / 300, 5);
  });

  it('charges a filler on the cycle’s own clock in full', () => {
    const base = singles({ respawnSeconds: 300 });
    const bare = estimateSpot(base, C);
    const e = estimateSpot({ ...base, filler: [{ ...rat, respawnSeconds: 300 }] }, C);
    const step = (bare.stepMs * 2) / 1000;
    expect(e.walkSeconds - bare.walkSeconds).toBeCloseTo(step, 5);
    expect(e.fillerExpPerCycle).toBeCloseTo(40, 5);
  });

  it('never grows past the room ceiling, and adds nothing to an unknown rate', () => {
    const waiting = singles({ rooms: 8, respawnSeconds: 3000 });
    expect(addFiller(waiting, [rat], 8, C).taken).toEqual([]);
    const unknown = singles({ respawnSeconds: null });
    expect(addFiller(unknown, [rat], 8, C).taken).toEqual([]);
  });
});

/*
 * The ring's order and length: nearest neighbour from the first room over
 * the sweep's own distances, the survey's out-and-back guess where a pair
 * lies beyond the measured reach.
 */
describe('the ring', () => {
  const room = (id: string, steps: number): HuntingRoom => ({
    id,
    map: 1,
    room: Number(id.split('/')[1]),
    name: id,
    steps
  });
  const rooms = [room('1/1', 5), room('1/2', 6), room('1/3', 9), room('1/4', 7)];
  const measured: Record<string, number> = {
    '1/1|1/2': 1,
    '1/2|1/4': 1,
    '1/4|1/3': 2,
    '1/3|1/1': 4,
    '1/1|1/4': 2,
    '1/2|1/3': 3
  };
  const distance = (a: string, b: string): number | null =>
    measured[`${a}|${b}`] ?? measured[`${b}|${a}`] ?? null;

  it('walks nearest neighbour from the first room and closes on it', () => {
    const { order, ringSteps } = orderRing(rooms, distance);
    expect(order.map((r) => r.id)).toEqual(['1/1', '1/2', '1/4', '1/3']);
    expect(ringSteps(1)).toBe(0);
    expect(ringSteps(2)).toBe(2);
    expect(ringSteps(4)).toBe(1 + 1 + 2 + 4);
  });

  it('prices an unmeasured pair from the two rooms’ distances from the character', () => {
    const { ringSteps } = orderRing([room('1/1', 5), room('1/9', 12)], () => null);
    // Out to the farther and back: |12 − 5| + 2, both ways.
    expect(ringSteps(2)).toBe(18);
  });
});

/** A spot with only its rates set, for the ranking. */
const spot = (
  key: string,
  rate: number | null,
  ceiling: number | null,
  deadly = false
): HuntingSpot => {
  const here: HuntingRoom = { id: '1/1', map: 1, room: 1, name: 'Here', steps: 3 };
  return {
    key,
    mobs: [],
    clock: 'delay',
    via: 'lair',
    boss: false,
    respawnSeconds: 30,
    spawns: 1,
    rooms: [here],
    filler: [],
    walk: [here],
    roomCount: 1,
    loopSteps: 0,
    estimate: {
      expPerHour: rate,
      ceilingPerHour: ceiling,
      expPerCycle: null,
      fillerExpPerCycle: 0,
      copperPerCycle: null,
      copperPerHour: null,
      cycleSeconds: null,
      combatSeconds: null,
      restSeconds: null,
      meditateSeconds: null,
      healCasts: null,
      poisonSeconds: null,
      walkSeconds: 0,
      stepMs: C.stepMs,
      waitSeconds: null,
      damagePerRoom: null,
      worstDamagePerRoom: null,
      worstDamageAtLeast: null,
      damageShare: null,
      worstShare: null,
      worstShareAtLeast: null,
      roundsPerKill: null,
      deadly,
      costly: false,
      trivial: false,
      unknown: []
    }
  };
};

describe('the order the reader wants', () => {
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
  /*
   * Todo 64: under a cash floor a spot paying it comes first, then the rest by
   * copper; deadly stays last. Soul, level 2: the cave bear pays no coin.
   */
  it('ranks a spot paying the cash floor above more exp, and deadly still last', () => {
    const paying = (key: string, exp: number, copper: number, deadly = false): HuntingSpot => {
      const s = spot(key, exp, exp, deadly);
      return { ...s, estimate: { ...s.estimate, copperPerHour: copper } };
    };
    const spots = [
      paying('cave bear', 15_000, 0),
      paying('kobold', 5_000, 300),
      paying('rats', 8_000, 40),
      paying('dragon', 90_000, 9_000, true)
    ];
    const floor = cashFloor(spots, 200, 0);
    expect([...spots].sort((a, b) => compareSpots(a, b, floor)).map((s) => s.key)).toEqual([
      'kobold',
      'rats',
      'cave bear',
      'dragon'
    ]);
    expect([...spots].sort(compareSpots).map((s) => s.key)).toEqual([
      'cave bear',
      'rats',
      'kobold',
      'dragon'
    ]);
  });

  /*
   * Todo 71: a floor nothing paid (14,225 copper an hour, the best ground 5,944)
   * ranked the realm by copper alone, and the cave bear earning 56k an hour
   * fell out of the measured list. Copper counts only within half the best exp.
   */
  it('never trades more than half the best exp for copper', () => {
    const paying = (key: string, exp: number, copper: number): HuntingSpot => {
      const s = spot(key, exp, exp);
      return { ...s, estimate: { ...s.estimate, copperPerHour: copper } };
    };
    const spots = [
      paying('thug', 4_353, 5_944),
      paying('cave bear', 8_935, 1_907),
      paying('azure slime', 7_500, 2_417)
    ];
    const floor = cashFloor(spots, 14_225, 0.5);
    expect(floor.expAtLeast).toBeCloseTo(4_467.5);
    expect([...spots].sort((a, b) => compareSpots(a, b, floor)).map((s) => s.key)).toEqual([
      'azure slime',
      'cave bear',
      'thug'
    ]);
  });

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

  /*
   * Where the fight itself went unpriced there is no cost beside the reward,
   * and ordering by the sweep put ten bone warriors above the rats a level-one
   * character could actually fight (2026-09-17). Nearest first, after every
   * spot whose fight was priced.
   */
  it('lists a fight nobody could price after every priced one, nearest first', () => {
    const unpriced = (key: string, steps: number, cycle: number): HuntingSpot => {
      const s = spot(key, null, cycle * 12);
      return {
        ...s,
        rooms: [{ ...s.rooms[0]!, steps }],
        estimate: { ...s.estimate, expPerCycle: cycle, unknown: ['rounds'] }
      };
    };
    const priced = spot('sewers', null, null);
    const ordered = [
      unpriced('bone warriors', 211, 270_000),
      {
        ...priced,
        estimate: { ...priced.estimate, expPerCycle: 5, unknown: ['respawn' as const] }
      },
      unpriced('rats', 6, 37)
    ].sort(compareSpots);
    expect(ordered.map((s) => s.key)).toEqual(['sewers', 'rats', 'bone warriors']);
  });
});

/*
 * The caster's half of the cycle (todo 26, 2026-09-12).
 *
 * A melee cycle is bounded by the health it loses and the time to get it
 * back; a caster's is bounded by the mana it spends and the time to
 * meditate it back — which is the reviewer's *cluster, room-spell, then sit*
 * play priced rather than written in.
 */
describe("a caster's cycle", () => {
  const caster = (over: Partial<SpotCharacter> = {}): Partial<SpotInput> => ({
    character: {
      ...melee,
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
    const blade = estimateSpot(singles(), C);
    const casting = estimateSpot(singles(caster()), C);
    expect(casting.cycleSeconds ?? 0).toBeGreaterThanOrEqual(blade.cycleSeconds ?? 0);
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

/*
 * Todo 70: what hunting a spot paid outranks the arithmetic, and the gap the
 * hunted spots show is carried to every spot not yet hunted. Soul's cave bear
 * was estimated at 8,935 an hour and earned 56,000 on orohost.
 */
describe('what hunting measured', () => {
  const use = {
    level: 5,
    now: 1_000_000,
    forgetMs: 600_000,
    minutesLeast: 10,
    paceLeast: 0.2,
    paceMost: 10,
    levelsAcross: 3
  };
  const rate = (perHour: number, over: Partial<MeasuredRate> = {}): MeasuredRate => ({
    perHour,
    minutes: 60,
    level: 5,
    at: 900_000,
    ...over
  });

  it('marks a hunted spot with what it paid, and paces the rest by the gap', () => {
    const { spots, pace } = withMeasured(
      [spot('bear', 8_000, 8_000), spot('thug', 4_000, 4_000)],
      new Map([['bear', rate(48_000)]]),
      use
    );
    expect(pace).toBe(6);
    expect(spots[0]!.estimate.measured).toEqual({ perHour: 48_000, minutes: 60, at: 900_000 });
    expect(spotRate(spots[0]!)).toBe(48_000);
    expect(spots[1]!.estimate.expPerHour).toBe(24_000);
    expect(spots[1]!.estimate.measured).toBeUndefined();
  });

  it('ignores a measurement at another level, too short, or too old', () => {
    for (const stale of [
      rate(48_000, { level: 4 }),
      rate(48_000, { minutes: 3 }),
      rate(48_000, { at: 0 })
    ]) {
      const { spots, pace } = withMeasured(
        [spot('bear', 8_000, 8_000)],
        new Map([['bear', stale]]),
        use
      );
      expect(pace).toBeNull();
      expect(spotRate(spots[0]!)).toBe(8_000);
    }
  });

  /* 2026-10-05: Straw-Floored Passage paid 3.3 times its estimate at levels 10, 12 and 14, and was priced bare at each new level. */
  it('carries what a spot paid over its estimate to a level near the one it was measured at', () => {
    const { spots, pace } = withMeasured(
      [spot('passage', 9_000, 9_000), spot('plateau', 20_000, 20_000)],
      new Map([
        ['passage', rate(30_000, { level: 4, estimated: 10_000 })],
        ['plateau', rate(13_000, { level: 4, estimated: 20_000 })]
      ]),
      use
    );
    expect(spots[0]!.estimate.expPerHour).toBe(27_000);
    expect(spots[1]!.estimate.expPerHour).toBe(13_000);
    expect(spots[0]!.estimate.measured).toBeUndefined();
    expect(spots[0]!.estimate.modelPerHour).toBe(9_000);
    // Nothing measured at level 5: the pace is the levels beside it.
    expect(pace).toBeCloseTo((3 + 0.65) / 2);
  });

  it('carries nothing from a level too far away, or from a rate kept without its estimate', () => {
    for (const far of [rate(30_000, { level: 1, estimated: 10_000 }), rate(30_000, { level: 4 })]) {
      const { spots, pace } = withMeasured(
        [spot('passage', 9_000, 9_000)],
        new Map([['passage', far]]),
        use
      );
      expect(pace).toBeNull();
      expect(spotRate(spots[0]!)).toBe(9_000);
    }
  });

  it('bounds the pace one strange ground puts on the realm', () => {
    const { pace } = withMeasured(
      [spot('bear', 1_000, 1_000)],
      new Map([['bear', rate(1_000_000)]]),
      use
    );
    expect(pace).toBe(10);
  });

  it('ranks a hunted spot on what it paid', () => {
    const { spots } = withMeasured(
      [spot('thug', 9_000, 9_000), spot('bear', 8_000, 8_000)],
      new Map([
        ['bear', rate(48_000)],
        ['thug', rate(4_000)]
      ]),
      use
    );
    expect([...spots].sort((a, b) => compareSpots(a, b)).map((s) => s.key)).toEqual([
      'bear',
      'thug'
    ]);
  });
});
