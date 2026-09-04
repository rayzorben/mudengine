import type { CharacterState } from '../../shared/character';

/**
 * Whether the character's mana is at or above a fraction of its maximum.
 *
 * A floor of 0 is no floor. An unknown maximum — a class with no mana has no
 * `MA=` on its status line at all — is *not* above any floor: unknown is not
 * plenty, the rule every threshold in this client follows, and a caster whose
 * sheet has not arrived yet waits for it rather than casting blind.
 */
export function manaAtLeast(state: CharacterState, floor: number): boolean {
  if (floor <= 0) return true;
  const { mana, manaMax } = state.vitals;
  if (mana === null || manaMax === null || manaMax <= 0) return false;
  return mana / manaMax >= floor;
}

/**
 * Whether a cast can be paid for at all.
 *
 * Separate from `manaAtLeast`, which is the player's *policy* — "do not spend
 * below a fifth of my pool" — where this is the realm's arithmetic: a spell
 * costing two kai cannot be cast on one, and the server answers `You do not
 * have enough mana to cast that spell.` **out loud, in the room**, once per
 * attempt. Captured from a live session (todo 10): `way of the owl` costs 2 and
 * the character had `KAI=1`, so a blessing due for a recast produced that line
 * every time the clock came round.
 *
 * There is no retry to arm and no event to schedule. Every caster in this
 * client re-derives its decision from each status line — and the status line is
 * exactly where mana changes — so *not proposing* while the pool is short is
 * already "evaluate on the next mana change", and the cast goes out on the
 * first line that can pay for it. A queued intent waiting on a number would be
 * a second thing to expire, cancel and keep in step with the pool.
 *
 * **Unknown does not refuse.** A cost nothing has stated and a pool nothing has
 * read are both absence, and standing every cast down for want of a lookup
 * would leave a character on a realm this client ships no data for unable to
 * heal at all. The refusal is only made where both halves are known and the
 * arithmetic is certain; anywhere else the server's own answer is the honest
 * failure. Compare `manaAtLeast`, where unknown *is* a refusal — that one is a
 * fraction of a maximum, and a maximum nobody has read cannot be a fifth of
 * anything.
 */
export function canPayFor(state: CharacterState, cost: number | null): boolean {
  if (cost === null || cost <= 0) return true;
  const { mana } = state.vitals;
  if (mana === null) return true;
  return mana >= cost;
}
