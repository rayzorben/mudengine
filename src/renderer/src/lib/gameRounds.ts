/**
 * The ring round the arena, as numbers (todo 154): when a round goes off on
 * this window's own clock, from the relative figures main publishes
 * (`RoundTiming`). Each automation push restates them; a restatement within
 * `RESYNC_MS` of the beat already held keeps it, so the ring's hand is not
 * restarted by the push's own delivery time.
 */
import type { RoundTiming } from '@shared/roundTiming';

/**
 * A restatement nearer than this to the beat held is the same beat, ms: a
 * push's delivery, well under the 250 ms median by which the fitted clock
 * misses the round (`decisions.md` › *A run steps in the off-rounds*).
 */
export const RESYNC_MS = 100;

/** A round's moment on this window's clock, the period, and the off-round after each round. */
export interface RoundAnchor {
  roundAt: number;
  periodMs: number;
  offRoundMs: number | null;
}

/** The anchor for `timing` received at `receivedAt`; `held` when it states the same beat. */
export function anchorOf(
  held: RoundAnchor | null,
  timing: RoundTiming | null,
  receivedAt: number
): RoundAnchor | null {
  if (timing === null) return null;
  const next: RoundAnchor = {
    roundAt: receivedAt + timing.nextInMs,
    periodMs: timing.periodMs,
    offRoundMs: timing.offRoundMs
  };
  if (held === null || held.offRoundMs !== next.offRoundMs) return next;
  // The beat is refitted every round of a fight, moving its period by a few ms; the held hand
  // is kept until that, or the round itself, has moved it by `RESYNC_MS`.
  if (Math.abs(held.periodMs - next.periodMs) >= RESYNC_MS) return next;
  const drift = mod(next.roundAt - held.roundAt, next.periodMs);
  return Math.min(drift, next.periodMs - drift) < RESYNC_MS ? held : next;
}

/** How far into its round the beat is at `now`, ms, from 0 at the round. */
export function intoRound(anchor: RoundAnchor, now: number): number {
  return mod(now - anchor.roundAt, anchor.periodMs);
}

function mod(x: number, p: number): number {
  return ((x % p) + p) % p;
}
