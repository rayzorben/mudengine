/**
 * When the room's next round goes off and how much of each round a step may
 * still go in (todo 154). A run's step into a lair goes at once while two
 * steps and the margin fit before the round, or as the round fires; that
 * stretch after each round is the off-round, the rest is held for the round
 * (`walk/OffRounds.ts`). The game view draws both as a ring round the room.
 * See `mudengine-automation` › parts/walking.md › *A run steps in the off-rounds*.
 */

/** The rounds as the window is told them: relative, so a web tab needs no shared clock. */
export interface RoundTiming {
  /** The beat's period, ms. */
  periodMs: number;
  /** From the moment this was published to the next round, ms. */
  nextInMs: number;
  /** How long after each round a step still goes, ms; null while no step is measured. */
  offRoundMs: number | null;
}

/** Whether a step with `leftMs` to the next round goes now rather than waiting for it. */
export function stepGoesNow(
  leftMs: number,
  periodMs: number,
  stepMs: number,
  marginMs: number
): boolean {
  return leftMs > 2 * stepMs + marginMs || periodMs - leftMs <= marginMs;
}

/** The off-round: how long after a round `stepGoesNow` holds, never under the margin. */
export function offRoundMs(periodMs: number, stepMs: number, marginMs: number): number {
  return Math.min(periodMs, Math.max(marginMs, periodMs - 2 * stepMs - marginMs));
}
