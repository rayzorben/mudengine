/**
 * How a route walk is going.
 *
 * In `shared/` rather than beside the walker because the renderer draws this
 * and the main process produces it, and `shared/` is the only module both may
 * import. Dependency-free, like everything else here.
 */
import type { RoomId } from './world';
import type { Afflictions } from './character';
import type { MovementConfig } from './config';

export type WalkStatus =
  /** Nothing planned. */
  | 'idle'
  /** A step is in flight and the client is waiting to confirm where it landed. */
  | 'walking'
  /** Every step confirmed. */
  | 'arrived'
  /** Ended early. `reason` says why. */
  | 'stopped';

export interface WalkProgress {
  status: WalkStatus;
  /** Steps confirmed so far — not steps sent. */
  done: number;
  total: number;
  /** Where the route ends, for display. */
  destination: string | null;
  /**
   * The room the route ends in, so the name can be a control rather than
   * text: a room the character is not in opens in the route panel, as a room
   * clicked on the map does. Null when the route's id did not parse.
   */
  destinationRoom: { map: number; room: number } | null;
  /** The step being attempted, when walking. `to` is the room it leads into. */
  step: {
    command: string;
    name: string;
    note: string | null;
    to: { map: number; room: number } | null;
  } | null;
  /**
   * The rooms the route still runs through, beginning with the one the
   * character is standing in.
   *
   * This is what the map draws the route with, and it is *remaining* rather
   * than whole on purpose: the request was for the way ahead, with the rooms
   * already travelled coming off as they are walked. `done` and `total` say
   * how far through a route is as a fraction; a fraction cannot be drawn on a
   * map, and re-deriving the rooms in the renderer would mean shipping the
   * whole route and the index and asking every consumer to slice it the same
   * way.
   *
   * The first entry is the room the character is in rather than the next one
   * it enters, because a line has two ends: without it the leg out of the
   * current room could not be drawn at all, which is the one leg being walked.
   *
   * Empty unless the walk is `walking`, for `step` and `hold`'s reason — a
   * stopped route drawn on the map is a plan the client is no longer following
   * and a picture that says otherwise is worse than none.
   */
  path: RoomId[];
  /**
   * Why it is no longer walking. Null while it still is.
   *
   * Always set when a walk stops, because "the bot stopped and I do not know
   * why" is the state this whole design exists to avoid.
   */
  reason: string | null;
  /**
   * Why the walk is standing still without having stopped. Null while it is
   * actually moving.
   *
   * A **hold is not an ending**, which is the distinction `LoopRunner` already
   * draws and for the same reason: a walk that stopped needs replanning from
   * wherever the character is, and one that is merely waiting will go on by
   * itself. Drawing them the same way would make a character recovering look
   * like a character that had given up.
   *
   * `health` is the character sitting the fight's damage off under
   * `automation.health.restBelow` before it travels on. `fight` is a fight
   * running in the room the route is standing in — which is the ordinary way
   * a journey across a realm full of monsters goes, and used to *end* the
   * route (2026-09-02): the character was left wherever the first wanderer
   * met it, and somebody had to notice and ask again.
   *
   * Reported rather than silent — a route that says *29 steps to Bank of
   * Godfrey* and does not move is otherwise indistinguishable from a broken
   * client, which is the failure every safety refusal here is written up to
   * avoid. It is reported *here* and not in the console: the card draws a
   * chip, the server has already said `*Combat Engaged*` in the room, and a
   * line per monster on a twenty-step journey is the chrome talking over it.
   */
  hold: WalkHold;
}

/**
 * Why a walk is standing still. `blind`, `held` and `poisoned` are the
 * afflictions the server has stated and the walk waits out — MegaMUD's
 * `IgnoreBlind` / `IgnorePoison` defaults, which wait — see
 * `afflictionHolding`.
 *
 * `barrier` is a shut door the ladder could not get past *this time round*:
 * every `open`, pick and bash the step was given has been spent and the way
 * is still closed. It is a hold rather than an ending because the reasons it
 * failed are mostly temporary — the character is too hurt to spend another
 * bash, the lock wanted one more roll, somebody else is about to walk through
 * — and a route that ends at a door has to be noticed and asked for again by
 * hand. See `Walker.holdAtBarrier`.
 */
export type WalkHold = 'health' | 'fight' | 'blind' | 'held' | 'poisoned' | 'barrier' | null;

/**
 * Which stated affliction stands a walk still, or null.
 *
 * **One predicate for the walker and the loop**, because two halves of one
 * gate in two files agree until one is edited (`fightIsRunning`'s own lesson).
 * Paralysis always holds: a step while held is a command spent to be refused,
 * and nothing in the options can make that a good idea. Blindness and poison
 * hold unless the player says otherwise — `walkWhileBlind`,
 * `walkWhilePoisoned` — because a blind character walking into a lair cannot
 * read the room it arrives in and misses every swing, and MegaMUD's own
 * defaults wait both out. Disease is not a movement matter and is left to the
 * cure. `unknown` never holds: nobody having said is not *yes*.
 */
export function afflictionHolding(
  afflictions: Afflictions,
  movement: Pick<MovementConfig, 'walkWhileBlind' | 'walkWhilePoisoned'>
): 'blind' | 'held' | 'poisoned' | null {
  if (afflictions.held === 'yes') return 'held';
  if (afflictions.blind === 'yes' && !movement.walkWhileBlind) return 'blind';
  if (afflictions.poisoned === 'yes' && !movement.walkWhilePoisoned) return 'poisoned';
  return null;
}

export const IDLE_WALK: WalkProgress = {
  status: 'idle',
  done: 0,
  total: 0,
  destination: null,
  destinationRoom: null,
  step: null,
  path: [],
  reason: null,
  hold: null
};
