/**
 * Whether the round's melee is expected to finish the monster (todo 54), so
 * an attack spell would spend mana on a kill the swing makes anyway. The
 * server runs one attack type a round (`Player.cs`, the `attackType` switch:
 * a spell round is `DoMagicRound` and no swing), so the spell held back is a
 * melee round instead. Expected, not certain: a round that falls short costs
 * one more round, after which the spell is wanted again. Unknown health or an
 * unpriced swing holds nothing. See `mudengine-automation` › `parts/combat.md`.
 */
import {
  swing,
  swingRound,
  type ProwessAttack,
  type ProwessSheet,
  type ProwessWeapon
} from './prowess';
import type { RealmFamily } from './realm';
import { prowessTargetOf, type TargetEntity } from './verdict';

/** The figures that held the spell: hit points believed left, and what a melee round lands. */
export interface MeleeFinish {
  left: number;
  round: number;
}

export function meleeFinishes(
  left: number | null,
  sheet: ProwessSheet,
  weapon: ProwessWeapon | null,
  entity: TargetEntity | undefined,
  family: RealmFamily | null,
  attack?: ProwessAttack
): MeleeFinish | null {
  if (left === null || left <= 0) return null;
  const blow = swing(sheet, weapon, prowessTargetOf(entity), family, attack);
  const round = blow === null ? null : swingRound(blow);
  return round === null || round < left ? null : { left, round };
}
