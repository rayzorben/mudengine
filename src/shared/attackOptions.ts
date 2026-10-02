/**
 * The attacks this character can make and what a round of each does, so a
 * fight's length is worked out for the attack actually typed (`a`, `aa`,
 * `sm`, `pu`, `kic`, `ju`) and a planner can choose between them on figures.
 *
 * An attack is offered only where the class or race row holds the ability
 * the server checks: `AttackCommand.cs` refuses a bash or smash without the
 * ability, and a punch, kick or jumpkick outside the Mystic class. An unread
 * row offers nothing but the plain attack, since a refused attack is a round
 * spent doing nothing.
 */
import { ATTACK_ABILITY, carriesAbility, MARTIAL_DAMAGE_ABILITY } from './abilities';
import { commandOf, type CommandName } from './commands';
import { abilitySum } from './light';
import {
  BARE_HAND,
  isMartial,
  martialRoundDamage,
  PLAIN_ATTACK,
  roundDamage,
  type AttackKind,
  type ProwessAttack,
  type ProwessSheet,
  type ProwessWeapon,
  type Reckoning
} from './prowess';
import type { RealmFamily } from './realm';

export interface AttackOption {
  /** What is typed: the realm's shortest spelling. */
  verb: string;
  kind: AttackKind;
  /** Damage a round before the target's armour, dodge and a miss; null where it cannot be worked out. */
  perRound: Reckoning<number> | null;
}

type Abilities = ReadonlyArray<readonly [number, number]> | null;

/** The verb each attack is offered as: the realm's shortest spelling. */
const ATTACKS: ReadonlyArray<{ verb: string; kind: AttackKind }> = [
  { verb: 'a', kind: 'attack' },
  { verb: 'aa', kind: 'bash' },
  { verb: 'sm', kind: 'smash' },
  { verb: 'pu', kind: 'punch' },
  { verb: 'kic', kind: 'kick' },
  { verb: 'ju', kind: 'jumpkick' }
];

/** Each attack command the realm's table reaches, by kind. */
const KIND_OF: Partial<Record<CommandName, AttackKind>> = {
  Attack: 'attack',
  Bash: 'bash',
  Smash: 'smash',
  Punch: 'punch',
  Kick: 'kick',
  Jumpkick: 'jumpkick'
};

/** A martial attack's own damage ability, summed off the class and race rows. */
const bonusOf = (kind: AttackKind, abilities: Abilities): number =>
  isMartial(kind) && abilities !== null ? abilitySum(abilities, MARTIAL_DAMAGE_ABILITY[kind]) : 0;

export function attackOptions(
  sheet: ProwessSheet,
  weapon: ProwessWeapon | null,
  abilities: Abilities,
  family: RealmFamily | null
): AttackOption[] {
  const options: AttackOption[] = [];
  for (const { verb, kind } of ATTACKS) {
    if (kind !== 'attack' && !carriesAbility(abilities, ATTACK_ABILITY[kind])) continue;
    const perRound = isMartial(kind)
      ? martialRoundDamage(sheet, kind, bonusOf(kind, abilities), family)
      : roundDamage(sheet, weapon ?? BARE_HAND, kind, family);
    options.push({ verb, kind, perRound });
  }
  return options;
}

/**
 * The attack `combat.attack` types, as the arithmetic prices it: its kind by
 * the realm's own command table (`ki`, `kic` and `kick` alike), and a martial
 * attack's damage bonus. A word the table does not take as an attack, or an
 * attack the class cannot make, is priced as the plain attack, which is the
 * figure there is for a round of `a`.
 */
export function attackFor(verb: string, abilities: Abilities): ProwessAttack {
  const command = commandOf(verb);
  const kind = command === null ? undefined : KIND_OF[command];
  if (kind === undefined || kind === 'attack') return PLAIN_ATTACK;
  if (!carriesAbility(abilities, ATTACK_ABILITY[kind])) return PLAIN_ATTACK;
  return { kind, bonus: bonusOf(kind, abilities) };
}
