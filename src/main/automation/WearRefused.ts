/**
 * The weapons the server would not put in hand this session. `You may not
 * wear that item!` names nothing (`EquipCommand.cs:130,170`: the item's own
 * `CanPlayerUseItem`, or a cursed item in the slot), so it is paired with the
 * `wear` it answers through the echo (`answeringAfter`). Festus asked for
 * Darkbane 7 times against a crowned spider while the ethereal dagger in his
 * pack could have hurt it (`logs/2026-11-01_06-08-34_festus.log:700`).
 */
import type { Block } from '../../shared/blocks';
import { echoes } from '../../shared/commands';
import { equip } from '../../shared/gear';
import { sameItem } from '../../shared/items';

export class WearRefused {
  private readonly refused: string[] = [];
  /** The level the refusals were heard at: a new level may lift a `MinLevel` refusal. */
  private level: number | null = null;

  /**
   * One block, with the command its answer belongs to. Returns `weapon` when
   * this is the server refusing the `wear` that asked for it, else null.
   */
  heard(block: Block, answering: string | null, weapon: string): string | null {
    if (block.type !== 'user-equipped-failed' || block.groups['item'] !== undefined) return null;
    if (!echoes(answering, equip(weapon))) return null;
    if (!this.refuses(weapon)) this.refused.push(weapon);
    return weapon;
  }

  /** Whether the server refused to put this weapon in hand this session. */
  refuses(weapon: string): boolean {
    return this.refused.some((name) => sameItem(name, weapon));
  }

  /** The character's level now; a change forgets every refusal. */
  atLevel(level: number | null): void {
    if (level === null || level === this.level) return;
    if (this.level !== null) this.refused.length = 0;
    this.level = level;
  }

  reset(): void {
    this.refused.length = 0;
    this.level = null;
  }
}
