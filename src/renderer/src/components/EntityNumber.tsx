/**
 * The realm's own number for a thing, beside its name.
 *
 * The `Monsters` row a monster is and the `Items` row an item is — the numbers
 * MegaMUD printed and the numbers the realm editor is indexed by. The client
 * has had them since the realm data was indexed and drew them nowhere, which
 * made every cross-reference to anything outside this client a name search.
 *
 * **One component for every surface that prints one**, so the pack, the shop's
 * shelf, a lair, the reference list and the panel a clicked name opens cannot
 * disagree about what a thing's number is — the `equipVerdict` argument, and
 * here it is load-bearing for a different reason: the answer is sometimes
 * *there isn't one*, and a surface that quietly drew nothing there would be
 * indistinguishable from a realm that has never heard of the thing.
 *
 * Two answers, from `entityNumber` and `entityRows` (`src/shared/entities.ts`),
 * which are exclusive:
 *
 * - **A number**, where one row answers — the realm places the name once, or a
 *   room settled which of several is standing in it.
 * - **How many rows share the name**, where several do and nothing settled it.
 *   `iron key` is three rows and `gnoll scout` is two; printing one of their
 *   numbers would be the coin toss `Traveller.keys` declines to make about a
 *   keyed door, so the count is drawn instead and the numbers go in the
 *   tooltip, where a reader who wants them can have all of them.
 *
 * Drawn as the existing quiet figure — `--text-lo-quiet`, `--font-mono`, the
 * treatment the reference list's own `.fig` already uses — because it is a
 * magnitude beside a name and not a fact about the thing.
 */
import { t } from '../lib/i18n';
import { entityNumber, entityRows, type Numbered } from '@shared/entities';

export interface EntityNumberProps {
  /** The entity, or the realm row, being named. */
  of: Numbered;
}

/**
 * The number as plain text, for a copy row, a table's find text and a sort
 * key. Null where there is nothing to say, so a caller can leave the cell
 * empty rather than filling it with a word.
 */
export function entityNumberText(of: Numbered): string | null {
  const id = entityNumber(of);
  if (id !== null) return t('entity.number', { id });
  const rows = entityRows(of);
  return rows === null ? null : t('entity.numberRows', { rows });
}

export default function EntityNumber({ of }: EntityNumberProps) {
  const id = entityNumber(of);
  if (id !== null) {
    return (
      <span className="entity-id" title={t('entity.numberTooltip')}>
        {t('entity.number', { id })}
      </span>
    );
  }
  const rows = entityRows(of);
  if (rows === null) return null;
  return (
    <span
      className="entity-id several"
      title={t('entity.numberRowsTooltip', { ids: (of.ids ?? []).join(', ') })}
    >
      {t('entity.numberRows', { rows })}
    </span>
  );
}
