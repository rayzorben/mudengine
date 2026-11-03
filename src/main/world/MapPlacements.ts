/**
 * The flat placements the maps were drawn on, kept per realm world (todo
 * 130, todo 20261102-1008-02). A centre that is one of a kept placement's
 * rooms is answered on that placement, at its own position, so a step, a
 * pan or a zoom inside it places nothing again and moves no cell; only a
 * centre outside every kept placement is placed afresh. Each placement is
 * numbered (`frame`) so a tab can say which one the cells it holds are in.
 * A world loaded afresh is a new key, so its old placements go with it.
 */
import { tuning } from '../app/tuning';
import type { MapAt } from '../../shared/mapPiece';
import { roomId, type RoomId } from '../../shared/world';
import { placeFlat, type FlatPlacement } from './flatPlacement';
import type { PlaneGraph } from './planeSteps';

/** A kept placement, numbered, with where the asked centre sits in it. */
export interface PlacedMap {
  readonly frame: number;
  readonly placement: FlatPlacement;
  /** The room asked about, and where it sits in the placement. */
  readonly centre: RoomId;
  readonly at: MapAt;
}

interface Kept {
  readonly frame: number;
  readonly placement: FlatPlacement;
  readonly where: ReadonlyMap<RoomId, MapAt>;
}

export class MapPlacements {
  private readonly kept = new WeakMap<PlaneGraph, Kept[]>();
  /*
   * Numbered from the clock at start, so a tab that outlives a restart never
   * names a frame of the old process that the new one has also numbered.
   */
  private next = Date.now();

  constructor(private readonly place: typeof placeFlat = placeFlat) {}

  /**
   * The placement `centre` is drawn on in `graph`: the tab's `prefer` when
   * it holds the centre, else the latest kept one that does, else a new one.
   * Null for a room the realm lacks.
   */
  of(graph: PlaneGraph, centre: RoomId, prefer: number | null = null): PlacedMap | null {
    const list = this.kept.get(graph) ?? [];
    const holding = list.filter((kept) => kept.where.has(centre));
    const found = holding.find((kept) => kept.frame === prefer) ?? holding.at(-1);
    if (found !== undefined) {
      // Most recently used last, so the limit drops the one unused longest.
      this.kept.set(graph, [...list.filter((kept) => kept !== found), found]);
      return placedAt(found, centre);
    }
    const placement = this.place(graph, centre);
    if (placement === null) return null;
    const where = new Map<RoomId, MapAt>();
    for (const { room, gx, gy } of placement.rooms) {
      where.set(roomId(room.map, room.room), { gx, gy });
    }
    const made: Kept = { frame: this.next, placement, where };
    this.next += 1;
    this.kept.set(graph, [...list, made].slice(-Math.max(1, tuning().world.mapPlacementsKept)));
    return placedAt(made, centre);
  }
}

/** The centre is the first room placed, so a fresh placement has it at the origin. */
function placedAt(kept: Kept, centre: RoomId): PlacedMap {
  const at = kept.where.get(centre) ?? { gx: 0, gy: 0 };
  return { frame: kept.frame, placement: kept.placement, centre, at };
}
