/**
 * The words a fight is fought with (todo 47): `combat.attack` and
 * `combat.opener` as typed, or, where blank, chosen from the class and race
 * rows (`chooseAttack`, `chooseOpener`). Every reader of the attack word
 * (auto-combat, the survey, the lair costs, the slot rankings, the Gear card)
 * reads it here. A fight swings the best round against its monster, the
 * prices read the best before armour, and a monster the realm cannot place
 * gets the latter, so the word sent lands at least what was priced.
 */
import { holdsAbility, CLASS_STEALTH_ABILITY, type Capabilities } from '../../shared/abilities';
import {
  chooseAttack,
  chooseOpener,
  type AttackChoice,
  type ChosenWords
} from '../../shared/attackChoice';
import { attackOptions, type AttackOption } from '../../shared/attackOptions';
import { backstabBlow } from '../../shared/backstab';
import type { CarriedItem, CharacterState } from '../../shared/character';
import { heldWeapon } from '../../shared/gear';
import type { CombatConfig } from '../../shared/config';
import type { ProwessClass, ProwessTarget } from '../../shared/prowess';
import type { RealmFamily } from '../../shared/realm';
import { backstabsWith, prowessSheetOf, wieldedWeapon } from '../../shared/verdict';

export interface FightWordParts {
  combat(): Pick<CombatConfig, 'attack' | 'opener'>;
  current(): CharacterState;
  /** The class row's figures and the server's family, without the attack (`Errands.classRows`). */
  rows(): ProwessClass & { family: RealmFamily | null };
  capabilities(): Capabilities;
  /** A monster's armour by name; null where the realm cannot place it. */
  targetOf(name: string): ProwessTarget | null;
  /** The carried weapon the gear sets wear for a backstab (`derivedBackstabWeapon`), or null. */
  backstabWeapon(): CarriedItem | null;
}

export interface FightWords {
  /** Each attack the rows allow and its round, as `as` stands, against `against` (mean) or before armour. */
  options(as: CharacterState, against?: readonly string[]): AttackOption[];
  /** The attack typed, or the best round against `against`, or before armour where none is placed. */
  attack(against?: readonly string[]): AttackChoice;
  /**
   * The opener typed, or `bs` where the class hides, the hand or the weapon
   * worn for the backstab can backstab, and its blow outdoes a plain round; or none.
   */
  opener(): string;
  /** What blank fields would choose, whatever is typed: the Combat page's placeholders. */
  untyped(): ChosenWords;
}

export function fightWords(parts: FightWordParts): FightWords {
  const options = (as: CharacterState, against: readonly string[] = []): AttackOption[] => {
    const { combat, magery, crits, family } = parts.rows();
    return attackOptions(
      prowessSheetOf(as, { combat, magery, crits }),
      wieldedWeapon(as.inventory.items),
      parts.capabilities().abilities,
      family,
      against.map((name) => parts.targetOf(name))
    );
  };
  /*
   * `realmClass` asks for the attack before armour at every site that prices a
   * fight, many times a line. A state is replaced, never changed, so one
   * pricing serves every ask until the next state. Realm data loading
   * without a new state waits for the next status line, a second at most.
   */
  let unarmoured: { state: CharacterState; choice: AttackChoice } | null = null;
  const beforeArmour = (state: CharacterState): AttackChoice => {
    if (unarmoured?.state !== state) {
      unarmoured = { state, choice: chooseAttack('', options(state)) };
    }
    return unarmoured.choice;
  };
  const can = (): { hides: boolean | null; backstabs: boolean | null; outdone: boolean } => {
    const state = parts.current();
    const items = state.inventory.items;
    const worn = parts.backstabWeapon();
    const weapon = worn ?? heldWeapon(items) ?? null;
    const blow = backstabBlow(
      { level: state.progress.level, stealth: state.progress.stealthSkill },
      weapon,
      items
    );
    const round = beforeArmour(state).perRound;
    return {
      hides: holdsAbility(parts.capabilities(), CLASS_STEALTH_ABILITY),
      backstabs: worn === null ? backstabsWith(items) : true,
      outdone: blow !== null && round !== null && blow < round
    };
  };
  return {
    options,
    attack: (against = []) => {
      const typed = parts.combat().attack;
      // A typed word needs no pricing, and the survey asks this once per lair.
      if (typed.trim().length > 0) return chooseAttack(typed, []);
      const state = parts.current();
      if (against.length > 0) {
        const armoured = chooseAttack(typed, options(state, against));
        if (armoured.why === 'best') return armoured;
      }
      return beforeArmour(state);
    },
    opener: () => chooseOpener(parts.combat().opener, can()),
    untyped: () => ({
      attack: beforeArmour(parts.current()),
      opener: chooseOpener('', can())
    })
  };
}
