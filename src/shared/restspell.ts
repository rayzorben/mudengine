/**
 * Whether a spell cast before a rest pays for itself (todo 60): the rest time
 * its `HPRegen` saves against the time its mana takes to come back. A cast
 * stands a resting character up (`Spell.cs:2006`), so the spell goes out
 * before the `rest`, never during one. See `mudengine-automation` ›
 * *A regeneration spell goes out before the rest*. Dependency-free.
 */

/** What the answer is read from; each figure the caller could not read is null. */
export interface RestSpellFigures {
  /** Hit points the rest has to bring back. */
  need: number;
  /** Hit points a rest tick returns as the character stands, and with the spell up. */
  restTick: number | null;
  restTickWith: number | null;
  /** Seconds the spell lasts. */
  lastsSeconds: number;
  /** Seconds between rest ticks, and between passive (mana) ticks, at the realm's speed. */
  restTickSeconds: number;
  passiveTickSeconds: number;
  /** Mana one cast costs, and what a passive tick returns. */
  cost: number | null;
  manaTick: number | null;
}

/**
 * `cast`, `saves-nothing` (the rest is as long with it up), `costs-more`
 * (the mana takes longer to come back than the rest time saved). Where the
 * regeneration cannot be figured the answer is `cast` with no saving: the
 * player named the spell, and MegaMUD's `RegenCmd` casts it unweighed.
 */
export type RestSpellAnswer =
  | { kind: 'cast'; savedSeconds: number | null }
  | { kind: 'saves-nothing' }
  | { kind: 'costs-more'; savedSeconds: number; paybackSeconds: number };

/** Rest ticks to bring back `need`, `ticksWith` of them at `fast` and the rest at `slow`. */
function ticksFor(need: number, slow: number, fast: number, ticksWith: number): number {
  if (ticksWith * fast >= need) return Math.ceil(need / fast);
  return ticksWith + Math.ceil((need - ticksWith * fast) / slow);
}

export function restSpellWorth(figures: RestSpellFigures): RestSpellAnswer {
  const { need, restTick, restTickWith, lastsSeconds, restTickSeconds } = figures;
  if (need <= 0) return { kind: 'saves-nothing' };
  if (restTick === null || restTickWith === null || restTick <= 0) {
    return { kind: 'cast', savedSeconds: null };
  }
  const ticksUp = Math.floor(lastsSeconds / restTickSeconds);
  const without = Math.ceil(need / restTick);
  const withIt = ticksFor(need, restTick, Math.max(restTickWith, restTick), ticksUp);
  const savedSeconds = (without - withIt) * restTickSeconds;
  if (savedSeconds <= 0) return { kind: 'saves-nothing' };
  const { cost, manaTick, passiveTickSeconds } = figures;
  if (cost === null || cost <= 0 || manaTick === null || manaTick <= 0) {
    return { kind: 'cast', savedSeconds };
  }
  const paybackSeconds = Math.ceil(cost / manaTick) * passiveTickSeconds;
  return paybackSeconds >= savedSeconds
    ? { kind: 'costs-more', savedSeconds, paybackSeconds }
    : { kind: 'cast', savedSeconds };
}
