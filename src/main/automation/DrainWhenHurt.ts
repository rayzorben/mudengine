/**
 * Drain when hurt (todo 841, from fatavatar `89e3584`): whether the drain
 * spells stand in for the attack spells now, and which. Below `drainBelow` of
 * maximum health they do, until health is back to `drainTo`; each edge is
 * said, and only while a drain can be cast. `AttackSpells` asks and casts.
 * The server heals the caster by what the drain takes (`Spell.cs:1418`,
 * `GMUDAbilityType.Drain`). The rules: `mudengine-automation` ›
 * `parts/combat.md` › *A drain spell stands in for the attack spell while hurt*.
 */
import { t } from '../app/i18n';
import type { CharacterState } from '../../shared/character';
import { holdsForVital, type SpellsConfig } from '../../shared/config';
import { weighsAsAttack } from '../../shared/spellchoice';
import { servesOf } from '../../shared/spellcraft';
import type { WorldSpell } from '../../shared/world';

/** The drains to cast this round: the room's, the single target's, or the book's best. */
export interface DrainStandIn {
  /** `areaDrain`, or empty where none is set: the ordinary room spell is not moved ahead. */
  area: string;
  /** `drain`, or empty: then *Auto Choose Best Spell* picks from the book's drains, when on. */
  single: string;
  /** Whether *Auto Choose Best Spell* picks the single-target drain. */
  choose: boolean;
}

export class DrainWhenHurt {
  /** The latch: `drainBelow` to start, `drainTo` to stop. */
  private holding = false;

  constructor(
    private spells: SpellsConfig,
    private readonly notice: (message: string) => void,
    private readonly realmSpell: (name: string) => WorldSpell | null,
    private readonly realmSpellById: (id: number) => WorldSpell | null
  ) {}

  configure(spells: SpellsConfig): void {
    this.spells = spells;
  }

  /** A new connection. */
  reset(): void {
    this.holding = false;
  }

  /** Whether anything is set that could drain, for the round tick. */
  get armed(): boolean {
    return this.spells.drainBelow > 0 && (this.named || this.spells.autoChoose);
  }

  /** Whether the latch is on: the drains are what the fight is cast with. */
  get draining(): boolean {
    return this.holding;
  }

  /** Whether the realm says this spell drains, read as the pickers read it (`servesOf`). */
  isDrain(spell: string): boolean {
    const row = this.realmSpell(spell);
    return row !== null && servesOf(row, this.realmSpellById).drains;
  }

  /**
   * Whether *Auto Choose Best Spell* could pick this drain (`weighsAsAttack`).
   */
  choosable(spell: string): boolean {
    const row = this.realmSpell(spell);
    return row !== null && weighsAsAttack(row) && this.isDrain(spell);
  }

  /**
   * The drains to cast now, or null for the ordinary choice. A drain is
   * castable when one is named, or when *Auto Choose Best Spell* is on and the
   * book holds one; nothing castable is nothing to switch to or announce.
   * Losing it mid-drain (the field cleared, the book re-read) is said as that,
   * since health is not back up.
   */
  standIn(state: CharacterState): DrainStandIn | null {
    const { drainBelow, drain, areaDrain, autoChoose } = this.spells;
    const choose = autoChoose && drain.length === 0 && this.bookDrains(state);
    const castable = this.named || choose;
    const holding =
      castable &&
      holdsForVital(state.vitals.hp, state.vitals.hpMax, drainBelow, this.until, this.holding);
    if (holding !== this.holding) this.say(holding, castable);
    this.holding = holding;
    return holding ? { area: areaDrain, single: drain, choose } : null;
  }

  /** The share of health the latch lets go at: `drainTo`, or `drainBelow` where it is 0. */
  private get until(): number {
    return this.spells.drainTo > 0 ? this.spells.drainTo : this.spells.drainBelow;
  }

  private get named(): boolean {
    return this.spells.drain.length > 0 || this.spells.areaDrain.length > 0;
  }

  private bookDrains(state: CharacterState): boolean {
    return (state.spellbook ?? []).some((spell) => this.choosable(spell.name));
  }

  private say(holding: boolean, castable: boolean): void {
    const percent = (value: number): number => Math.round(value * 100);
    this.notice(
      holding
        ? t('automation.spells.drainStarts', {
            below: percent(this.spells.drainBelow),
            to: percent(this.until)
          })
        : castable
          ? t('automation.spells.drainEnds')
          : t('automation.spells.drainNone')
    );
  }
}
