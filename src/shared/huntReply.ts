/**
 * What the Hunting card is answered (todo 20261102-2305-02). The card hands
 * back the key of the survey it holds; while nothing the survey reads but the
 * room has moved, main answers `same` with the steps from where the character
 * stands now, and the card puts them on the survey it has. See
 * `mudengine-session` › parts/hosts.md.
 */
import type { GatedGround, HuntingAdvice, HuntingRoom, HuntingSpot } from './hunting';
import { sameJson } from './values';
import type { RoomId } from './world';

/** Where the character stands now, for a survey the card already holds. */
export interface HuntingMoved {
  from: HuntingAdvice['from'];
  swept: number;
  gated: GatedGround[];
  /** Fewest steps to each of `huntingRooms(advice)`, in that order. */
  steps: number[];
}

/**
 * `whole` is a survey to draw; `key` is what to hand back on the next ask, null
 * where the answer is not kept (a refusal). `same` says the survey under `key`
 * still stands, moved to where the character is.
 */
export type HuntingReply =
  | { kind: 'whole'; key: string | null; advice: HuntingAdvice }
  | { kind: 'same'; key: string; moved: HuntingMoved };

function spotRooms(spot: HuntingSpot): HuntingRoom[] {
  return [...spot.rooms, ...spot.filler, ...spot.walk];
}

/** Every room a survey names, each once, in the order both sides read `HuntingMoved.steps` by. */
export function huntingRooms(advice: HuntingAdvice): RoomId[] {
  const seen = new Set<RoomId>();
  for (const spot of [...advice.spots, ...advice.unmeasured]) {
    for (const room of spotRooms(spot)) seen.add(room.id);
  }
  return [...seen];
}

/**
 * The survey with `moved` put on it; the same survey where nothing it draws
 * differs; null where the steps are not for this survey's rooms, which the
 * card answers by asking for the whole survey again.
 */
export function movedTo(advice: HuntingAdvice, moved: HuntingMoved): HuntingAdvice | null {
  const rooms = huntingRooms(advice);
  if (rooms.length !== moved.steps.length) return null;
  const steps = new Map(rooms.map((id, index) => [id, moved.steps[index]!]));
  const unchanged =
    sameJson(advice.from, moved.from) &&
    advice.swept === moved.swept &&
    sameJson(advice.gated, moved.gated) &&
    [...advice.spots, ...advice.unmeasured].every((spot) =>
      spotRooms(spot).every((room) => steps.get(room.id) === room.steps)
    );
  if (unchanged) return advice;
  const restep = (room: HuntingRoom): HuntingRoom => ({
    ...room,
    steps: steps.get(room.id) ?? room.steps
  });
  const respot = (spot: HuntingSpot): HuntingSpot => ({
    ...spot,
    rooms: spot.rooms.map(restep),
    filler: spot.filler.map(restep),
    walk: spot.walk.map(restep)
  });
  return {
    ...advice,
    from: moved.from,
    swept: moved.swept,
    gated: moved.gated,
    spots: advice.spots.map(respot),
    unmeasured: advice.unmeasured.map(respot)
  };
}
