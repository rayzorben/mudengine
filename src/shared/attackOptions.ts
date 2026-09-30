/**
 * The attacks this character can make and what a round of each does, so the
 * planner chooses `a`, `aa`, `sm`, `pu`, `kic` or `ju` from figures rather
 * than a guess (todo 53).
 *
 * An attack is offered only where the class or race row holds the ability
 * the server checks: `AttackCommand.cs` refuses a bash or smash without the
 * ability, and a punch, kick or jumpkick outside the Mystic class. An unread
 * row offers nothing but the plain attack, since a refused attack is a round
 * spent doing nothing.
 */
import { ATTACK_ABILITY, MARTIAL_DAMAGE_ABILITY } from './abilities';
import { abilitySum } from './light';
import {
  martialRoundDamage,
  roundDamage,
  type MartialAttack,
  type ProwessSheet,
  type ProwessWeapon,
  type Reckoning,
  type SwingMethod
} from './prowess';
import type { RealmFamily } from './realm';

export type AttackKind = SwingMethod | MartialAttack;

export interface AttackOption {
  /** What is typed: the realm's shortest spelling. */
  verb: string;
  kind: AttackKind;
  /** Damage a round before the target's armour, dodge and a miss; null where it cannot be worked out. */
  perRound: Reckoning<number> | null;
}

/** The verb each attack is typed as: the realm's shortest spelling. */
const ATTACKS: ReadonlyArray<{ verb: string; kind: AttackKind }> = [
  { verb: 'a', kind: 'attack' },
  { verb: 'aa', kind: 'bash' },
  { verb: 'sm', kind: 'smash' },
  { verb: 'pu', kind: 'punch' },
  { verb: 'kic', kind: 'kick' },
  { verb: 'ju', kind: 'jumpkick' }
];

/**
 * The bare hand's range and speed (`PlayerAttackType.Min`/`Max`/`Speed` with
 * no weapon equipped): 1–3 at 1200.
 */
const BARE_HAND: ProwessWeapon = { min: 1, max: 3, speed: 1200 };

export function attackOptions(
  sheet: ProwessSheet,
  weapon: ProwessWeapon | null,
  abilities: ReadonlyArray<readonly [number, number]> | null,
  family: RealmFamily | null
): AttackOption[] {
  const options: AttackOption[] = [];
  const holds = (id: number): boolean => abilities?.some(([which]) => which === id) ?? false;
  for (const { verb, kind } of ATTACKS) {
    if (kind !== 'attack' && !holds(ATTACK_ABILITY[kind])) continue;
    const perRound =
      kind === 'attack' || kind === 'bash' || kind === 'smash'
        ? roundDamage(sheet, weapon ?? BARE_HAND, kind, family)
        : martialRoundDamage(
            sheet,
            kind,
            abilities === null ? 0 : abilitySum(abilities, MARTIAL_DAMAGE_ABILITY[kind]),
            family
          );
    options.push({ verb, kind, perRound });
  }
  return options;
}
