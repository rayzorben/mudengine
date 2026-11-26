/**
 * Whether the attack spell is held back this round for the melee (todo 54):
 * the round's swing is expected to finish the monster (`meleeFinishes`). The
 * server runs one attack type a round (`Player.cs`, the `attackType` switch),
 * so a held spell is a melee round. There is no hold for a monster worth less
 * a point of mana than another in the room: a swing is never better than the
 * best spell (the user, 2026-11-25). `of` only answers; `AttackSpells` decides
 * what is held and calls `say` where the hold stops a cast. The rules:
 * `mudengine-automation` › `parts/combat.md` › *A spell is held back where
 * the swing finishes the monster*.
 */
import type { SpellTarget } from './AttackSpells';
import { t } from '../app/i18n';
import type { CharacterState } from '../../shared/character';
import type { NoticeSink } from '../../shared/decisionSettings';
import { meleeFinishes, type MeleeFinish } from '../../shared/meleeFinishes';
import type { FightingClass } from '../../shared/prowess';
import { prowessSheetOf, wieldedWeapon } from '../../shared/verdict';
import { mobKey } from '../../shared/world';

/** Why the spell is held back, with the figures. */
export interface SpellHeld {
  kind: 'melee';
  finish: MeleeFinish;
}

/** The realm's row behind a spell's target, else its printed name: a notice holds for every spawn. */
export function spellTargetRow(target: Pick<SpellTarget, 'name' | 'entity'>): string {
  return target.entity?.name ?? target.name;
}

export class SpellHold {
  /** The holds said this fight, by kind and monster. */
  private readonly said = new Set<string>();

  constructor(
    private readonly notice: NoticeSink,
    private readonly realmClass: () => FightingClass
  ) {}

  fightEnded(): void {
    this.said.clear();
  }

  /**
   * The hold on `target` this round, or null. `swing` is the verb the round
   * would swing, empty where no swing lands: then nothing is held, or the
   * round would be empty.
   */
  of(state: CharacterState, target: SpellTarget, swing: string): SpellHeld | null {
    if (swing.length === 0) return null;
    const cls = this.realmClass();
    const finish = meleeFinishes(
      target.remaining,
      prowessSheetOf(state, cls),
      wieldedWeapon(state.inventory.items),
      target.entity ?? undefined,
      cls.family,
      cls.attack
    );
    return finish === null ? null : { kind: 'melee', finish };
  }

  /** Says the hold that stopped a cast at `target`, once a fight per monster and kind. */
  say(held: SpellHeld, spellTarget: SpellTarget, swing: string): void {
    const target = spellTarget.name;
    const key = `${held.kind}\u0000${mobKey(spellTargetRow(spellTarget))}`;
    if (this.said.has(key)) return;
    this.said.add(key);
    this.notice(
      t('automation.spells.heldForMelee', {
        target,
        left: held.finish.left,
        verb: swing,
        round: Math.round(held.finish.round)
      }),
      'spell-held-melee'
    );
  }
}
