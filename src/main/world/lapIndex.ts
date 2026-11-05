/**
 * Which loops' laps walk through a room, for the Loops modal's Passes
 * through here (todo 20261020-1303-01). A loop is kept as its fewest
 * waypoints, so a room between two stops is in no stop list; only the planned
 * lap knows it. Each loop's legs are planned by the `planLegs` the caller
 * gives, which main makes the session's own lap leg on the route worker
 * (`LapPlanner`), so the rooms are the ones the running lap walks, fights
 * weighed as the lap weighs them. The shipped shelf is 3,447 legs (14.8 s on
 * Paradigm, 2026-10-20), and on main one leg held the thread for up to 310 ms.
 */
import type { Loop } from '../../shared/loops';
import type { RoomId } from '../../shared/world';
import { lapLegs, travellerFingerprint, type StopPlace } from './loopDraft';
import type { Traveller, WorldGraph } from './WorldGraph';

export interface LapIndex {
  /** The names of the loops whose lap walks through `room`, stops included. */
  through(room: RoomId): readonly string[];
  /** Loops with a stop the realm cannot settle, left out. */
  unresolved: readonly string[];
}

/** Each leg's rooms, every step's both ends; none for a leg with no way. */
export type PlanLegs = (legs: ReadonlyArray<readonly [RoomId, RoomId]>) => Promise<RoomId[][]>;

/** Null when `cancelled` answers true between two loops. */
export async function buildLapIndex(
  loops: readonly Loop[],
  resolve: (stop: StopPlace) => RoomId | null,
  planLegs: PlanLegs,
  cancelled: () => boolean
): Promise<LapIndex | null> {
  const byRoom = new Map<RoomId, string[]>();
  const unresolved: string[] = [];
  for (const loop of loops) {
    const legs = lapLegs(loop, resolve);
    if (legs === null) {
      unresolved.push(loop.name);
      continue;
    }
    if (cancelled()) return null;
    const planned = await planLegs(legs);
    if (cancelled()) return null;
    const rooms = new Set(planned.flat());
    for (const room of rooms) {
      const names = byRoom.get(room);
      if (names === undefined) byRoom.set(room, [loop.name]);
      else names.push(loop.name);
    }
  }
  return { through: (room) => byRoom.get(room) ?? [], unresolved };
}

/** What one session's index is planned over. */
export interface LapIndexAsk {
  /** The realm, by identity: a realm swapped underneath is planned again. */
  graph: WorldGraph;
  loops: readonly Loop[];
  /** What the lap's leg prices against; only the parts a route depends on key the index. */
  traveller: Traveller;
  resolve: (stop: StopPlace) => RoomId | null;
  planLegs: PlanLegs;
}

interface Build {
  key: string;
  graph: WorldGraph;
  cancelled: boolean;
  index: Promise<LapIndex | null>;
}

/**
 * One session's lap index, kept while the realm, the loops and the traveller
 * it was planned for hold, and planned again when one moves: a loop added, a
 * level gained, a switch that opens a door. The first ask waits for the
 * build; a build the next ask makes stale is cancelled, and whoever waited on
 * it is answered from the newer one. Disposed with the session, so a build
 * for a character that was unloaded stops at its next leg.
 */
export class LapIndexCache {
  private held: Build | null = null;
  private disposed = false;

  async index(ask: LapIndexAsk): Promise<LapIndex | null> {
    if (this.disposed) return null;
    const key = `${travellerFingerprint(ask.traveller)}#${loopsKey(ask.loops)}`;
    const held = this.held;
    if (held === null || held.graph !== ask.graph || held.key !== key) {
      if (held !== null) held.cancelled = true;
      const build: Build = {
        key,
        graph: ask.graph,
        cancelled: false,
        index: Promise.resolve(null)
      };
      build.index = buildLapIndex(
        ask.loops,
        ask.resolve,
        ask.planLegs,
        () => build.cancelled || this.disposed
      );
      this.held = build;
    }
    for (;;) {
      const current = this.held;
      if (current === null) return null;
      const index = await current.index;
      if (index !== null) return index;
      // Cancelled: by a newer ask, whose build is waited on next, or by dispose.
      if (this.disposed || this.held === current) return null;
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.held !== null) this.held.cancelled = true;
    this.held = null;
  }
}

/** What of a loop a lap's rooms depend on: its stops in order, and whether it bounces. */
function loopsKey(loops: readonly Loop[]): string {
  return JSON.stringify(
    loops.map((loop) => [loop.name, loop.bounce === true, loop.stops.map((stop) => stop.room)])
  );
}
