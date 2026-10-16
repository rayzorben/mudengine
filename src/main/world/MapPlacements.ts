/**
 * The last flat placement each session's map asked for, one per session
 * (todo 130). A pan or a zoom round the same centre asks for a new window of
 * the same placement, which is then decorated without placing again; a new
 * centre, or a realm loaded afresh, replaces it.
 */
import type { RoomId } from '../../shared/world';
import { placeFlat, type FlatPlacement } from './flatPlacement';
import type { PlaneGraph } from './planeSteps';

interface Kept {
  graph: PlaneGraph;
  placement: FlatPlacement;
}

export class MapPlacements {
  private readonly kept = new Map<string, Kept>();

  /** The placement round `centre` in `graph` for this session, or null for a room it lacks. */
  of(session: string, graph: PlaneGraph, centre: RoomId): FlatPlacement | null {
    const known = this.kept.get(session);
    if (known !== undefined && known.graph === graph && known.placement.centre === centre) {
      return known.placement;
    }
    const placement = placeFlat(graph, centre);
    if (placement === null) this.kept.delete(session);
    else this.kept.set(session, { graph, placement });
    return placement;
  }

  /** A closed session's entry goes with it. */
  forget(session: string): void {
    this.kept.delete(session);
  }
}
