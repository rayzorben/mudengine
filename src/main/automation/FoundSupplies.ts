/**
 * A supplies row marked *done once found* taken off the list once the pack
 * holds its maximum (todo 20261024-1810-01). Armed by the pack confirming a
 * pick-up of that row (`You took …`), decided on the next state, when the
 * listing counts it, so a floor listing or a pick-up under the maximum
 * removes nothing. Composed by `AutoLoot`, which takes the item up.
 */
import { t } from '../app/i18n';
import type { Block } from '../../shared/blocks';
import type { CharacterState } from '../../shared/character';
import type { NoticeSink } from '../../shared/decisionSettings';
import { bareName } from '../../shared/items';
import type { SupplyItem } from '../../shared/packConfig';
import {
  carriedCount,
  stockCeiling,
  supplyFor,
  type SupplyListWriter
} from '../../shared/supplies';
import { nameAnswersTo } from '../../shared/world';

export class FoundSupplies {
  /** Rows a pick-up named, waiting for the pack to count it, by the row's own name. */
  private readonly taken = new Set<string>();

  constructor(
    private readonly writer: SupplyListWriter | undefined,
    private readonly notice: NoticeSink
  ) {}

  /** The pack confirmed a pick-up: arm the row it fills, when that row is done once found. */
  onBlock(block: Block, rows: readonly SupplyItem[]): void {
    if (block.type !== 'player-gets' || block.groups['player'] !== undefined) return;
    const item = bareName(block.groups['item'] ?? '');
    if (item.length === 0) return;
    const row = rows.find((each) => each.doneOnFound && nameAnswersTo(item, bareName(each.name)));
    if (row !== undefined) this.taken.add(row.name);
  }

  /** The pack as it now stands: a row at its maximum is taken off the list, once. */
  onCharacter(state: CharacterState, rows: readonly SupplyItem[]): void {
    for (const name of [...this.taken]) {
      const row = supplyFor(rows, name);
      if (row === null || !row.doneOnFound) {
        this.taken.delete(name);
        continue;
      }
      const have = carriedCount(state, row.name);
      if (have < stockCeiling(row)) continue;
      this.taken.delete(name);
      const removed = this.writer?.dropSupply(row.name) === true;
      this.notice(
        removed
          ? t('automation.supplies.doneOnFound', { item: row.name, count: have })
          : t('automation.supplies.doneOnFoundNotWritten', { item: row.name }),
        'supply-found'
      );
    }
  }

  reset(): void {
    this.taken.clear();
  }
}
