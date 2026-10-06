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
  swing,
  swingRound,
  type AttackKind,
  type ProwessAttack,
  type ProwessSheet,
  type ProwessTarget,
  type ProwessWeapon,
  type Reckoning
} from './prowess';
import type { RealmFamily } from './realm';

export interface AttackOption {
  /** What is typed: the realm's shortest spelling. */
  verb: string;
  kind: AttackKind;
  /**
   * Damage a round: what lands on the monsters it was priced against, their
   * armour, dodge and resistance counted, else before any of them; null where
   * it cannot be worked out.
   */
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

/**
 * Each attack the class or race row allows and its round. Against monsters,
 * the round is what lands on them, the mean over them (`swing`): a bash's
 * bigger blow at fifteen less accuracy is a worse round than a punch against
 * armour, which the round before the roll cannot show (2026-10-05: Konami
 * chose `aa` for Soul, 10 a round against a tortured spirit where the
 * server's own `st a` put punch at 35). A null target is a monster nobody can place, and
 * makes every round unknown. With none, the round before any armour.
 */
export function attackOptions(
  sheet: ProwessSheet,
  weapon: ProwessWeapon | null,
  abilities: Abilities,
  family: RealmFamily | null,
  against: ReadonlyArray<ProwessTarget | null> = []
): AttackOption[] {
  const options: AttackOption[] = [];
  for (const { verb, kind } of ATTACKS) {
    if (kind !== 'attack' && !carriesAbility(abilities, ATTACK_ABILITY[kind])) continue;
    const bonus = bonusOf(kind, abilities);
    const perRound =
      against.length > 0
        ? landedOn(sheet, weapon, { kind, bonus }, family, against)
        : isMartial(kind)
          ? martialRoundDamage(sheet, kind, bonus, family)
          : roundDamage(sheet, weapon ?? BARE_HAND, kind, family);
    options.push({ verb, kind, perRound });
  }
  return options;
}

/** What a round of the attack lands, the mean over the monsters; null where any target or blow is unknown. */
function landedOn(
  sheet: ProwessSheet,
  weapon: ProwessWeapon | null,
  attack: ProwessAttack,
  family: RealmFamily | null,
  against: ReadonlyArray<ProwessTarget | null>
): Reckoning<number> | null {
  let total = 0;
  for (const target of against) {
    const blow = target === null ? null : swing(sheet, weapon, target, family, attack);
    const round = blow === null ? null : swingRound(blow);
    if (round === null) return null;
    total += round;
  }
  return { value: total / against.length, from: 'bound' };
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
