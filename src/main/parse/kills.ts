/**
 * The monsters seen to die since the session last asked, by the realm's row.
 *
 * Out of `CharacterTracker` (todo 724; `mudengine-wire` › `parts/tracker.md`).
 * Noted from the two cases that decide a death — this character's experience
 * line and the room's death sentence — and taken by `QuestWatch.noteKilled`
 * through the tracker's `takeDeaths`: a death is a fact and what to do about
 * it is somebody else's. Why a death owns a quest step whoever landed it:
 * `mudengine-world` › `parts/quests.md`.
 */
import type { CharacterState } from '../../shared/character';
import { killedAlone } from '../../shared/company';
import type { MobLore } from '../../shared/lore';
import { rowNameOf } from '../../shared/mobs';
import { mobKey } from '../../shared/world';

export class Kills {
  /**
   * The realm rows of monsters seen to die since this was last taken.
   *
   * Rows rather than the room's spelling (`rowNameOf`), because what reads
   * this is a quest step naming a monster out of the `Monsters` table, and a
   * **set** because two of one name dying is one answer to that question —
   * which also bounds it whatever a caller that never drains does.
   */
  private readonly deaths = new Set<string>();

  /** `known`: whether the realm knows a monster by this name (`WorldGraph.mob`). */
  constructor(
    private readonly known: (name: string) => boolean,
    private readonly lore: Pick<MobLore, 'observeKillExp'> = {}
  ) {}

  /**
   * This character's kill of its target: noted, and what it paid kept for the realm where
   * nobody could have shared it (todo 70). The database's experience is not
   * what the wire pays, and a shared kill pays a share.
   */
  killed(state: CharacterState, exp: number, at: number): void {
    const name = state.combat.target;
    if (name === null) return;
    this.noted(name);
    if (killedAlone(state)) this.lore.observeKillExp?.(name, exp, at);
  }

  /**
   * A monster died, whoever landed it: written down under the realm's own row.
   *
   * Whoever landed it, because the server casts a monster's death spell on
   * everybody standing in the room (`Mob.ApplyDeathSpell`), so a quest step a
   * death runs runs for the party and not only for the killer.
   */
  noted(name: string): void {
    const row = rowNameOf(mobKey(name), this.known);
    if (row.length > 0) this.deaths.add(row);
  }

  /** Which monsters have died since this was last asked. Cleared by the taking. */
  take(): string[] {
    if (this.deaths.size === 0) return [];
    const dead = [...this.deaths];
    this.deaths.clear();
    return dead;
  }

  /** A kill nobody read before the session or the socket ended can no longer be acted on. */
  forget(): void {
    this.deaths.clear();
  }
}
