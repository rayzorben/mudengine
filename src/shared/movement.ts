/**
 * Moving, or stopped — the only question a player asks about where a
 * character is going.
 *
 * A route and a loop are one mechanism underneath: a loop's legs are routes
 * the loop plans one at a time, and `Walker` walks both. They were **two
 * things on screen** until 2026-09-11, with their own transport controls, and
 * that was the mistake: the Route face carried a Stop of its own beside the
 * Loop face's play, pause and stop, so *stop* meant two different things
 * depending on which crumb was forward, and neither said what the character
 * was actually doing.
 *
 * The player's model is three words. **Routing** is walking somewhere.
 * **Looping** is walking round. **Stopped** is neither, and a stop is a pause
 * that may or may not be permanent: whatever was being walked keeps its place,
 * and play picks it back up from wherever the character now stands.
 *
 * So this is the one reading of the two progresses, and it is here — pure, in
 * `shared/` — because three surfaces have to agree about it: the Navigation
 * card draws one face and no more, the toolbar draws one transport button, and
 * `walkNotices` withholds the arrival of a leg that is not a journey. Three
 * copies of "is this a loop?" is three places to disagree.
 */
import type { LoopProgress } from './loops';
import type { WalkProgress } from './walk';
import type { Route } from './world';

/** What the character is going about, when it is going about anything. */
export type MovementKind = 'route' | 'loop';

export interface Movement {
  /** Which of the two, or null when the character is going nowhere. */
  kind: MovementKind | null;
  /** Started. A hold is still started — the client means to walk on. */
  moving: boolean;
  /**
   * Pressing play would pick something back up.
   *
   * False for a route that **arrived**: it is still the movement the card
   * reports on, because the reason a journey ended is the half of it a player
   * acts on, but there is nothing left of it to walk.
   */
  resumable: boolean;
}

export const NOT_MOVING: Movement = { kind: null, moving: false, resumable: false };

/**
 * Which of the two the character is on, and whether it is going.
 *
 * **What is happening outranks what is remembered, and what the player asked
 * for outranks what the client walked**. The ordering is the whole of it:
 *
 * 1. A **running loop** is the movement. Its legs are walks it owns, so the
 *    walk underneath is that loop's footwork rather than anything the player
 *    asked for — which is why no arrival is announced during one
 *    (`walkNotices`): a two-room lap would announce one every five seconds.
 * 2. Otherwise a **walking route** is, because somebody asked for it just now.
 * 3. Otherwise a **route the player asked for that arrived or stopped**,
 *    because the card goes on reporting the journey that ended — "it stopped
 *    and I do not know why" is the state this client's whole decision trace
 *    exists to prevent, and asking for a route is what stopped the lap
 *    underneath it in the first place (`SessionManager.walkRoute`).
 * 4. Otherwise a **stopped loop**, which is the longer-lived memory: stopping
 *    a lap to walk to a shop and back leaves the lap there to press play on
 *    when you arrive.
 * 5. Otherwise a walk nobody asked for that is no longer idle — a leg, an
 *    errand, a walk home — with no lap left to attribute it to.
 *
 * **`walk.asked` is load-bearing between 3 and 4.** Stopping a lap stops the
 * leg it was walking, so the walker is then holding a stopped route that is
 * the lap's own footwork; without the test, every stopped lap would be drawn
 * as a stopped *route*, reporting the mechanism instead of the thing
 * happening. With it, the one case that had two answers has one: the player's
 * own route wins while there is one to report, and the lap is still in the
 * card's picker to start again.
 *
 * Nothing is destroyed to keep this unambiguous: a route the player asks for
 * stops a *running* lap (you cannot do both) and leaves a stopped one alone.
 * `kind` is null only where nothing has been walked at all.
 */
export function movementOf(walk: WalkProgress, loop: LoopProgress): Movement {
  if (loop.status === 'running') return { kind: 'loop', moving: true, resumable: false };
  if (walk.status === 'walking') return { kind: 'route', moving: true, resumable: false };
  if (walk.asked && walk.status !== 'idle') {
    return { kind: 'route', moving: false, resumable: walk.status === 'stopped' };
  }
  if (loop.status === 'stopped') return { kind: 'loop', moving: false, resumable: true };
  if (walk.status === 'idle') return NOT_MOVING;
  return { kind: 'route', moving: false, resumable: false };
}

/**
 * What main answers when the player presses play.
 *
 * Three outcomes and no string overloading: it started, it could not, or it
 * needs asking about first. The third is the one this type exists for — the
 * character has wandered a long way from whatever it was walking, and walking
 * it back is a journey in its own right that nobody asked for.
 *
 * A union rather than `string | null`, because the third outcome carries
 * figures the window has to draw and there is no honest way to put them in a
 * refusal string that the window then has to take apart again.
 */
export type MovementStart =
  /** Walking again. */
  | { started: true }
  /** It could not start, and this is why, in the realm's or the client's words. */
  | { refused: string }
  /**
   * How far the character has wandered from what it was walking, and what
   * walking back would cost. The window asks; pressing play again with
   * `confirmed` walks it.
   */
  | { confirm: MovementConfirm };

/**
 * What is being asked about.
 *
 * The two movements, and **back** — a press of the toolbar's back button that
 * the realm cannot answer in one step. It is its own word rather than `route`
 * because the question is a different one: not *this is further than you
 * agreed to*, but *the way back is not a step*, and a window drawing the two
 * with one sentence would say neither.
 */
export type ConfirmKind = MovementKind | 'back';

/**
 * What main answers when the player presses Walk on a plan that is on screen.
 *
 * `MovementStart`'s three answers with a fourth, and the fourth is the one
 * this type exists for: the plan was drawn from a room the character has
 * since left, so it cannot be walked as written and has been drawn again from
 * where the character now stands. The reader gets the **new plan**, not a
 * refusal about the old one — which is what a stale plan used to earn, with
 * nothing to press next but the same button that had just failed.
 *
 * Its own union rather than a fourth arm of `MovementStart`, because play and
 * back cannot produce it: both plan from where the character is standing at
 * the moment of the press, so a plan they hand to the walker is never stale.
 */
export type WalkStart = { started: true } | { refused: string } | { replanned: Replanned };

/**
 * A plan drawn again from here, and why the old one would not do.
 *
 * **Both halves, never one**: a character that has wandered and a way that now
 * wants a key are two different reasons to look again, they can arrive
 * together, and a sentence naming one hides the other.
 */
export interface Replanned {
  /** The way from where the character now stands. Walkable; never blocked. */
  route: Route;
  /**
   * How far the character has strayed from the room the old plan began in, in
   * steps the router counts — null where the realm cannot price the way back,
   * which is not zero and is asked about rather than waved through.
   */
  wandered: number | null;
  /** What the new way asks that the old one did not, named. See `newDemands`. */
  demands: string[];
}

/** What the window is asking about: which movement, what it is called, how far. */
export interface MovementConfirm {
  kind: ConfirmKind;
  /** The lap's name, or the room the route — or the way back — is heading for. */
  name: string;
  /**
   * Steps. For a movement picked back up, how many *more* than it still owed
   * when it stopped; for a back press, the whole way back.
   */
  steps: number;
}
