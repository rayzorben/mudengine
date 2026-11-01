/**
 * How many rounds a kill takes. A round's blows land together and a monster
 * dies on the round its health runs out, so a kill is a whole number of
 * rounds: Festus's 2,100 horned spiders (660 health, about 550 a round) each
 * died on the second round, never after 1.2 (fight record, 2026-11-01). The
 * odds book's run rolls whole rounds already; this is the arithmetic's
 * reading of the same thing. See `mudengine-world` › parts/hunting.md ›
 * *A kill takes whole rounds*.
 */

/** Past this many rounds the whole-round count is the plain ratio and half a round. */
const SUMMED_ROUNDS_MOST = 1000;
/** A round's chance of still finding the target standing below which the sum stops. */
const STANDING_LEAST = 1e-6;

/**
 * The expected rounds to take `health` off at `perRound` a round, a round's
 * damage spread by `variance`: `Σ P(k rounds leave it standing)` over k from
 * 0, k rounds read as normal with k times the round's mean and variance. With
 * no spread it is `ceil(health / perRound)`; with a wide one it falls towards
 * the ratio plus half a round.
 */
export function roundsToKill(health: number, perRound: number, variance: number): number {
  if (!(health > 0) || !(perRound > 0)) return Number.POSITIVE_INFINITY;
  const ratio = health / perRound;
  if (ratio > SUMMED_ROUNDS_MOST) return ratio + 0.5;
  const spread = Math.max(0, variance);
  let rounds = 0;
  for (let k = 0; ; k += 1) {
    const dealt = k * perRound;
    const standing =
      k === 0
        ? 1
        : spread === 0
          ? dealt < health
            ? 1
            : 0
          : normalBelow((health - dealt) / Math.sqrt(k * spread));
    if (standing < STANDING_LEAST && dealt >= health) return rounds;
    rounds += standing;
  }
}

/** The standard normal's share below `x` (Abramowitz and Stegun 7.1.26, within 1.5e-7). */
function normalBelow(x: number): number {
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const poly =
    t *
    (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-z * z);
  return x >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}
