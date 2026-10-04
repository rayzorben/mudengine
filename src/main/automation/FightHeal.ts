/**
 * What a heal in a fight has to beat (todo 23). Casting ends the attack, so a
 * heal that mends less than the monsters deal a round gives the round away for
 * nothing. This character's own blows taken this fight decide once a round has
 * closed, the realm's figure for the monsters in the fight before that, and a
 * share of what is missing where neither is known; the blows already landed
 * this round raise any of them. See `mudengine-automation` › parts/recovery.md.
 */
import { fightIsRunning, type CharacterState } from '../../shared/character';
import type { Block } from '../../shared/blocks';
import type { HealAim } from '../../shared/spellchoice';
import { figure } from '../../shared/values';
import { tuning } from '../app/tuning';
import type { SessionModule } from './Module';
import { RoundBeat } from './RoundBeat';

/** Which figure set the floor: this fight's rounds, the realm's, this round's blows, or the share. */
export type FightHealBasis = 'measured' | 'realm' | 'round' | 'share';

export interface FightHealFloor {
  basis: FightHealBasis;
  /** Hit points a cast must be expected to mend to be worth the round. */
  floor: number;
}

export class FightHeal implements SessionModule {
  private readonly beat = new RoundBeat();
  private started = false;
  private closedRounds = 0;
  private closedDamage = 0;
  private thisRound = 0;

  constructor(
    /** What the monsters in the fight are expected to deal this character a round, or null. */
    private readonly realmPerRound: (state: CharacterState) => number | null
  ) {}

  onBlock(block: Block): void {
    if (this.beat.onBlock(block)) this.closeRound();
    // A blow on this character and damage nothing named (a spell's line, the
    // room) are both taken, as the session's tally counts them.
    if (block.type === 'mob-hits' || block.type === 'user-takes-damage') {
      this.thisRound += figure(block.groups['damage']) ?? 0;
    }
  }

  /** A fight over is forgotten: the next one is measured from its own blows. */
  onCharacter(state: CharacterState): void {
    if (!fightIsRunning(state)) this.reset();
  }

  /**
   * The floor for a heal on `aim`. A member's blows are not this character's,
   * so a heal on one is weighed by the share alone, as before todo 23.
   */
  floor(aim: HealAim, deficit: number, state: CharacterState): FightHealFloor {
    const share = { basis: 'share' as const, floor: tuning().spells.fightHealShare * deficit };
    if (aim !== 'self') return share;
    const realm = this.closedRounds > 0 ? null : this.realmPerRound(state);
    const known: FightHealFloor | null =
      this.closedRounds > 0
        ? { basis: 'measured', floor: this.closedDamage / this.closedRounds }
        : realm === null
          ? null
          : { basis: 'realm', floor: realm };
    const base = known ?? share;
    return this.thisRound > base.floor ? { basis: 'round', floor: this.thisRound } : base;
  }

  reset(): void {
    this.beat.reset();
    this.started = false;
    this.closedRounds = 0;
    this.closedDamage = 0;
    this.thisRound = 0;
  }

  private closeRound(): void {
    if (this.started) {
      this.closedRounds += 1;
      this.closedDamage += this.thisRound;
    }
    this.started = true;
    this.thisRound = 0;
  }
}
