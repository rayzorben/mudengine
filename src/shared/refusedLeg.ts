/**
 * A loop's leg the plan refused, as the capture keeps it (todo
 * 20261105-1440-01): where it was planned from, the stop, the walk's kind, the
 * refusal, and what walled the way that wants no stopper. A stop like Rayzor's
 * at the Dark Cavern is read back from this the next morning. Written only
 * where a capture is open (`logging.capture`). `mudengine-automation` ›
 * `parts/loops.md`.
 */
import type { WalkKind } from './walk';
import { describeBlock, type RoomId, type Route } from './world';

export interface RefusedLeg {
  /** Where the leg was planned from; null where the client could not place the character. */
  from: RoomId | null;
  /** The stop, as the loop names it. */
  stop: string;
  kind: WalkKind;
  /** The refusal, as said; null where the route carried none. */
  reason: string | null;
  /** What stood in the way, each as said (`Route.blocks`). */
  blocks: string[];
  /**
   * The way that crosses no room wanting a stopper (`Route.withoutStopper`):
   * its length, the rooms on it expected to kill, and its walls, each as
   * said. Null where the refusal carried none.
   */
  round: {
    steps: number;
    deadly: Array<{ room: RoomId; name: string }>;
    walls: string[];
  } | null;
}

/** The record of a refused leg, from the refused route. */
export function refusedLegOf(
  from: RoomId | null,
  stop: string,
  kind: WalkKind,
  route: Route
): RefusedLeg {
  const round = route.withoutStopper;
  return {
    from,
    stop,
    kind,
    reason: route.reason ?? null,
    blocks: (route.blocks ?? []).map(describeBlock),
    round:
      round === undefined
        ? null
        : {
            steps: round.steps.length,
            deadly: round.steps
              .filter((step) => step.deadly === true)
              .map((step) => ({ room: step.to, name: step.name })),
            walls: (round.walls ?? []).map(describeBlock)
          }
  };
}
