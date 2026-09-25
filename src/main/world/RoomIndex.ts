/**
 * What the router reads of a realm: its rooms, the edges beside the exit
 * table, and the few catalogue lookups a price or a sentence on a route needs.
 *
 * Beneath both sides — `Router` reads it, and `WorldGraph` composes it from its
 * own tables and the `Catalogue`'s rows (todo 711) — so the router imports
 * neither. See `mudengine-world` › `parts/routing.md`.
 */
import type {
  Landing,
  RemoteLever,
  Requirement,
  RoomId,
  RouteInvocation,
  RouteStep,
  SpellHazard,
  WorldItem,
  WorldRoom,
  WorldSpell
} from '../../shared/world';

/**
 * A room-script teleport the router may walk — `dive pool`, `go vortex`.
 *
 * Shaped like a `WorldExit` so the A* relaxes both through one loop, with the
 * one honest difference stated in the type: it has no compass direction,
 * because the realm moves the character by coordinates rather than through an
 * exit, and a fabricated direction would be resolved against an exit that
 * does not exist. The requirement carries the phrase in `commands` (so the
 * route step's command is the phrase, exactly as a `Text:` exit's is) and the
 * level gate when the script states one.
 */
export interface PortalExit {
  direction: 'portal';
  map: number;
  room: number;
  requirement: Requirement;
}

/**
 * A timed passage a route walks into (`RoomCommand.casts`), with the spell's
 * id: the plan's snag drops it and the route's hazard keeps it.
 */
export interface Passage {
  id: number;
  spell: string;
  rooms: number;
  ends: boolean;
  ticks?: number;
  then?: string;
}

export interface RoomIndex {
  /** Every room, by `map/room`. The router holds the table: it reads it on every edge. */
  readonly roomsById: ReadonlyMap<RoomId, WorldRoom>;
  /** The room-script teleports and room-bound item landings, by the room offering them. */
  readonly portalsByRoom: ReadonlyMap<RoomId, readonly PortalExit[]>;
  /** What each item edge spends, keyed by the edge: `RouteStep.invoke` less where. */
  readonly spendsByEdge: ReadonlyMap<PortalExit, Omit<RouteInvocation, 'at'>>;
  /** The items that teleport from wherever the character stands, as edges. */
  itemLandings(): ReadonlyArray<PortalExit>;
  /** The levers that open this step without leaving the room, or none. */
  leversHere(from: RoomId, direction: string): readonly RemoteLever[];
  /** What a room's own spell does to whoever stands in it, for this level. */
  hazardOf(room: WorldRoom, level?: number | null): SpellHazard | null;
  /** The timed passages a route walks into. */
  corridorsOn(steps: readonly RouteStep[]): Passage[];
  /** Every room where an item can be had: a counter, a dropper's spawn, a word. */
  sourceRooms(item: number): ReadonlySet<RoomId>;
  item(id: number): WorldItem | undefined;
  spellById(id: number): WorldSpell | null;
  byId(id: RoomId): WorldRoom | undefined;
  landingCount(landing: Landing): number;
  namedClasses(): Record<number, string>;
  namedRaces(): Record<number, string>;
}
