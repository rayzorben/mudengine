/**
 * Reading the room again after a kill whose death spell summons (todo 57).
 *
 * What it brings arrives in silence: `Mob.Death` casts the death spell and
 * `Room.TrySummon` adds the row with no entry line when a monster cast it
 * (GreaterMUD Room.cs:322), all before `Killed` prints `You gain N experience.`
 * (Mob.cs:1008, PlayerAttackType.cs:266). MajorMUD prints only the spell's own
 * text (captures/077). The read is `FloorAfterKill`'s, which the walk already
 * waits on, so the next step goes only once the listing says what came.
 * See `mudengine-automation` › `parts/walking.md`.
 */
import { deathNamed, type Block } from '../../shared/blocks';
import type { CharacterState } from '../../shared/character';
import { deathSummons } from '../../shared/summons';
import { mobKey } from '../../shared/world';
import { t } from '../app/i18n';
import type { FloorAfterKill } from './FloorAfterKill';

export class DeathSummons {
  constructor(private readonly floor: Pick<FloorAfterKill, 'ask'>) {}

  /**
   * A death in `state`'s room, read before the tracker takes the dead monster
   * out: its sentence names it, and the experience line stands for the target.
   * A death nobody can name reads the room when anything here could summon,
   * since an unknown is the unsafe case.
   */
  onBlock(block: Block, state: CharacterState): void {
    if (state.phase !== 'in-game') return;
    const dead = block.type === 'user-gain-experience' ? state.combat.target : deathNamed(block);
    if (dead === null && block.type !== 'user-gain-experience') return;
    const key = dead === null ? null : mobKey(dead);
    const summoner = state.room.occupants.find(
      (who) =>
        (key === null || mobKey(who.name) === key) &&
        who.mob !== undefined &&
        deathSummons(who.mob).length > 0
    );
    if (summoner === undefined) return;
    this.floor.ask(t('automation.walk.reasonDeathSummons', { mob: summoner.name }));
  }
}
