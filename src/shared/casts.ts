/**
 * What a `spell-cast` line with an amount did (todo 20261018-1314-01). The word
 * before the amount and the word after it each carry it: `for 20 damage` hurts,
 * while `for 20 healing` (captures/003), `healing 16 damage` (captures/048) and
 * `regenerating 19 damage` (captures/004) heal. Reading only the first word
 * took `for 20 healing` for a blow.
 */
export type CastEffect = 'harm' | 'heal';

/**
 * A cast that prints no amount (`Eagle casts greater healing on you!`, captures/060)
 * is a heal when the classifier found the realm's row heals (`heals`), else null.
 */
export function castEffect(groups: Readonly<Record<string, string>>): CastEffect | null {
  const kind = groups['kind'];
  if (kind === undefined || groups['amount'] === undefined)
    return groups['heals'] === 'yes' ? 'heal' : null;
  return kind === 'for' && groups['effect'] !== 'healing' ? 'harm' : 'heal';
}
