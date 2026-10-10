/**
 * What a hunting spot's spawn draws into its room, for the survey (todo 24):
 * each monster `Joiners` finds, at the chances the fight odds roll it
 * (`expectedSummons` for a call for aid, the death spell less its
 * resistance, the arrival's copies). One level: what a joiner calls in turn
 * is the fight odds' alone. See mudengine-automation › *A fight counts the
 * monsters it draws in*.
 */
import type { Joiners } from '../world/joiners';
import type { MobEntity } from '../../shared/entities';
import type { SpotJoiner, SpotMob } from '../../shared/hunting';
import type { MenacePlayer } from '../../shared/menace';
import { expectedSummons, spellEffect, worstModel } from '../../shared/mobRound';
import { copiesOf } from '../../shared/summons';

export function spotJoiners(
  entity: MobEntity,
  joiners: Pick<Joiners, 'drawnIn' | 'arrivalsOf'>,
  player: MenacePlayer,
  priced: (entities: MobEntity[]) => SpotMob[]
): SpotJoiner[] {
  const calls = expectedSummons(worstModel(entity, player));
  const death =
    entity.deathSpell === undefined
      ? null
      : spellEffect(entity.spells?.[entity.deathSpell], 0, player);
  const dying = copiesOf(death?.summons ?? []);
  const arriving = copiesOf(joiners.arrivalsOf(entity));
  const rows = new Set([...calls.keys(), ...dying.keys(), ...arriving.keys()]);
  if (rows.size === 0) return [];
  const met = joiners.drawnIn([entity], true).filter(({ row }) => rows.has(row));
  const mobs = priced(met.map(({ entity: joiner }) => joiner));
  return met.map(({ row }, index) => ({
    mob: mobs[index]!,
    perRound: calls.get(row) ?? 0,
    onDeath: (dying.get(row) ?? 0) * (1 - (death?.resist ?? 0)),
    onArrival: arriving.get(row) ?? 0
  }));
}
