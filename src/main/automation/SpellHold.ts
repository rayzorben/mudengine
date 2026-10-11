/**
 * Whether the attack spell is held back this round for the melee (todo 54):
 * the round's swing is expected to finish the monster (`meleeFinishes`), or
 * the monster is worth less a point of mana than another the room lists and
 * the spendable pool cannot pay for both (`saveTheMana`). The server runs one
 * attack type a round (`Player.cs`, the `attackType` switch), so a held spell
 * is a melee round. `of` only answers; `AttackSpells` decides what is held
 * and calls `say` where the hold stops a cast. The rules:
 * `mudengine-automation` › `parts/combat.md` › *A spell is held back where
 * the swing or the next monster serves better*.
 */
import type { SpellTarget } from './AttackSpells';
import { killCasting } from './killCasting';
import { t } from '../app/i18n';
import { standingOf, type CharacterState } from '../../shared/character';
import { killPrice, saveTheMana, type KillPrice, type ManaHeld } from '../../shared/manaWorth';
import { meleeFinishes, type MeleeFinish } from '../../shared/meleeFinishes';
import { attacksFirst, type MobRule } from '../../shared/mobRules';
import type { FightingClass, ProwessSheet } from '../../shared/prowess';
import { spellTargetOf, type NoEffectOn } from '../../shared/spellchoice';
import { prowessSheetOf, wieldedWeapon } from '../../shared/verdict';
import { mobKey, type WorldSpell } from '../../shared/world';

/** Why the spell is held back, with the figures. */
export type SpellHeld = { kind: 'melee'; finish: MeleeFinish } | { kind: 'worth'; held: ManaHeld };

export class SpellHold {
  /** The holds said this fight, by kind and monster. */
  private readonly said = new Set<string>();

  constructor(
    private readonly notice: (message: string) => void,
    private readonly realmSpell: (name: string) => WorldSpell | null,
    private readonly realmClass: () => FightingClass,
    private readonly noEffectOn: NoEffectOn
  ) {}

  fightEnded(): void {
    this.said.clear();
  }

  /**
   * The hold on `target` this round, or null. `swing` is the verb the round
   * would swing, empty where no swing lands: then nothing is held, or the
   * round would be empty. `floor` is the mana the spell may not spend
   * (`minMana` of the maximum), kept out of the pool the worth weighs.
   */
  of(
    state: CharacterState,
    target: SpellTarget,
    swing: string,
    rules: readonly MobRule[],
    floor: number
  ): SpellHeld | null {
    if (swing.length === 0) return null;
    const cls = this.realmClass();
    const sheet = prowessSheetOf(state, {
      combat: cls.combat,
      magery: cls.magery,
      crits: cls.crits
    });
    const finish = meleeFinishes(
      target.remaining,
      sheet,
      wieldedWeapon(state.inventory.items),
      target.entity ?? undefined,
      cls.family,
      cls.attack
    );
    if (finish !== null) return { kind: 'melee', finish };
    const held = this.worth(state, target, sheet, cls, rules, floor);
    return held === null ? null : { kind: 'worth', held };
  }

  /** Says the hold that stopped a cast at `target`, once a fight per monster and kind. */
  say(held: SpellHeld, target: string, swing: string): void {
    const key = `${held.kind}\u0000${mobKey(target)}`;
    if (this.said.has(key)) return;
    this.said.add(key);
    this.notice(
      held.kind === 'melee'
        ? t('automation.spells.heldForMelee', {
            target,
            left: held.finish.left,
            verb: swing,
            round: Math.round(held.finish.round)
          })
        : t('automation.spells.heldForWorth', {
            target,
            verb: swing,
            exp: held.held.here.experience,
            mana: Math.round(held.held.here.mana),
            next: held.held.next.name,
            nextExp: held.held.next.experience,
            nextMana: Math.round(held.held.next.mana),
            pool: Math.round(held.held.pool)
          })
    );
  }

  /**
   * The kill against the best of the room's other monsters that attack on
   * sight: those are the next fight whatever is decided here.
   */
  private worth(
    state: CharacterState,
    target: SpellTarget,
    sheet: ProwessSheet,
    cls: FightingClass,
    rules: readonly MobRule[],
    floor: number
  ): ManaHeld | null {
    const book = state.spellbook;
    const { mana, manaMax } = state.vitals;
    if (book === null || mana === null) return null;
    const kept = floor > 0 && manaMax !== null ? Math.ceil(floor * manaMax) : 0;
    const casting = killCasting(state, book, this.realmSpell, sheet, cls.family, this.noEffectOn);
    const here = killPrice(
      casting,
      target.name,
      target.entity?.experience,
      spellTargetOf(target.entity, target.remaining)
    );
    if (here === null) return null;
    const key = mobKey(target.name);
    const standing = standingOf(state);
    const others: KillPrice[] = [];
    for (const who of state.room.occupants) {
      if (who.kind !== 'mob' || who.mob === undefined || mobKey(who.name) === key) continue;
      if (attacksFirst(who, standing, rules) !== true) continue;
      const price = killPrice(
        casting,
        who.name,
        who.mob.experience,
        spellTargetOf(who.mob, who.mob.hp ?? null)
      );
      if (price !== null) others.push(price);
    }
    return saveTheMana(Math.max(0, mana - kept), here, others);
  }
}
