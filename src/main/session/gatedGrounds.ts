/**
 * The hunting grounds behind a level gate (todo 2322-01): the rooms a sweep
 * at any level reaches that the survey's sweep at this level does not,
 * grouped as the survey groups them (`spawnGroundOf`), the best paying first,
 * each with the least level whose sweep reaches it. The Hunting card lists
 * them below the spots. Sweeps, not routes: a whole-realm sweep is 26–50ms on
 * Paradigm, and a leg to a gated room 497ms, refused with no wall named
 * (2026-10-27). A ground behind anything else (a key, a class) no level
 * opens, and is left out. A higher level is taken to reach no less: a way
 * open only to a band of levels (`Level: 0 to 5`) is one this level already
 * walks or never will, so a ground behind one is left out, never misplaced.
 */
import type { Errands } from './Errands';
import type { Navigation } from './navigation';
import { GROUNDS, spawnGroundOf, type GroundWorld } from './huntGrounds';
import type { WorldGraph } from '../world/WorldGraph';
import type { CharacterState } from '../../shared/character';
import type { GatedGround, HuntVia } from '../../shared/hunting';
import type { RoomId, WorldRoom } from '../../shared/world';

export interface GatedParts {
  world(): (GroundWorld & Pick<WorldGraph, 'byId'>) | undefined;
  navigation: Pick<Navigation, 'within'>;
  errands: Pick<Errands, 'travellerNow' | 'reachKey'>;
}

/** Past this many levels over the character's, a gate is no level's: the doubling search stops. */
const LEVELS_SEARCHED = 1 << 12;

/** One ground the wide sweep met: its rooms, the nearest first. */
interface Met {
  via: Exclude<HuntVia, 'seen'>;
  room: WorldRoom;
  at: RoomId;
  steps: number;
  rooms: RoomId[];
}

export class GatedGrounds {
  /** Each ground's opening level, kept while the realm and what decides a way (`reachKey`) hold. */
  private kept: { world: object; key: string; opens: Map<string, number | null> } | null = null;

  constructor(private readonly parts: GatedParts) {}

  /**
   * The grounds within `radius` of `from` that `reach` (the survey's sweep)
   * left out for a level gate, at most `limit`, paying most first. Empty
   * while worldless or while the level is unread: nothing says what it shuts.
   */
  around(
    state: CharacterState,
    from: RoomId,
    radius: number,
    reach: ReadonlyMap<RoomId, number>,
    limit: number
  ): GatedGround[] {
    const world = this.parts.world();
    const level = state.progress.level;
    if (world === undefined || level === null) return [];
    const traveller = this.parts.errands.travellerNow(state);
    const sweeps = new Map<number, ReadonlyMap<RoomId, number>>();
    const sweep = (at: number): ReadonlyMap<RoomId, number> => {
      const kept = sweeps.get(at);
      if (kept !== undefined) return kept;
      const swept = this.parts.navigation.within(from, radius, { ...traveller, level: at });
      sweeps.set(at, swept);
      return swept;
    };
    const met = this.met(world, sweep(Number.MAX_SAFE_INTEGER), reach);
    const ranked = [...met]
      .map(([key, ground]) => {
        const mobs = GROUNDS[ground.via].entities(world, {
          room: ground.room,
          at: ground.at,
          came: [],
          timed: null
        });
        const paid = mobs.flatMap((mob) => (mob.experience === undefined ? [] : [mob.experience]));
        return {
          key,
          ground,
          mobs: mobs.map((mob) => mob.name),
          experience: paid.length === 0 ? null : Math.max(...paid)
        };
      })
      .sort(
        (a, b) => (b.experience ?? -1) - (a.experience ?? -1) || a.ground.steps - b.ground.steps
      )
      .slice(0, limit);
    const opens = this.opens(world, state);
    const unknown = ranked.filter(({ key }) => !opens.has(key));
    for (const [key, at] of openingLevels(
      new Map(unknown.map(({ key, ground }) => [key, ground.rooms])),
      level,
      sweep
    )) {
      opens.set(key, at);
    }
    return ranked.flatMap(({ key, ground, mobs, experience }) => {
      const at = opens.get(key) ?? null;
      return at === null
        ? []
        : [
            {
              key,
              mobs,
              experience,
              roomCount: ground.rooms.length,
              steps: ground.steps,
              level: at
            }
          ];
    });
  }

  /** The grounds the wide sweep reaches with no room in `reach`. */
  private met(
    world: Pick<WorldGraph, 'byId'>,
    wide: ReadonlyMap<RoomId, number>,
    reach: ReadonlyMap<RoomId, number>
  ): Map<string, Met> {
    const met = new Map<string, Met>();
    const open = new Set<string>();
    for (const [id, steps] of wide) {
      const room = world.byId(id);
      const ground = room === undefined ? null : spawnGroundOf(room);
      if (room === undefined || ground === null) continue;
      if (reach.has(id)) {
        open.add(ground.key);
        continue;
      }
      const seen = met.get(ground.key);
      if (seen === undefined) {
        met.set(ground.key, { via: ground.via, room, at: id, steps, rooms: [id] });
      } else {
        seen.rooms.push(id);
        if (steps < seen.steps) met.set(ground.key, { ...seen, room, at: id, steps });
      }
    }
    for (const key of open) met.delete(key);
    return met;
  }

  private opens(world: object, state: CharacterState): Map<string, number | null> {
    const key = this.parts.errands.reachKey(state);
    if (this.kept === null || this.kept.world !== world || this.kept.key !== key) {
      this.kept = { world, key, opens: new Map() };
    }
    return this.kept.opens;
  }
}

/**
 * The least level above `level` whose sweep reaches any of each ground's
 * rooms, or null past `LEVELS_SEARCHED`: a doubling search for a level that
 * opens them all, then halving within it, the sweeps shared across grounds.
 */
export function openingLevels(
  grounds: ReadonlyMap<string, readonly RoomId[]>,
  level: number,
  sweep: (level: number) => ReadonlyMap<RoomId, number>
): Map<string, number | null> {
  const found = new Map<string, number | null>();
  const opensAt = (at: number, key: string): boolean =>
    (grounds.get(key) ?? []).some((room) => sweep(at).has(room));
  let high = level + 1;
  let keys = [...grounds.keys()];
  while (keys.some((key) => !opensAt(high, key)) && high - level < LEVELS_SEARCHED) {
    high = level + 2 * (high - level);
  }
  const shut = keys.filter((key) => !opensAt(high, key));
  for (const key of shut) found.set(key, null);
  keys = keys.filter((key) => !shut.includes(key));
  const assign = (low: number, top: number, among: string[]): void => {
    if (among.length === 0) return;
    if (low === top) {
      for (const key of among) found.set(key, low);
      return;
    }
    const middle = Math.floor((low + top) / 2);
    const opened = among.filter((key) => opensAt(middle, key));
    assign(low, middle, opened);
    assign(
      middle + 1,
      top,
      among.filter((key) => !opened.includes(key))
    );
  };
  assign(level + 1, high, keys);
  return found;
}
