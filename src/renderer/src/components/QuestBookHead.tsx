import { useMemo } from 'react';

import { ListTools, type ListFilter } from './ListTools';
import Kpi from './viz/Kpi';
import Ring from './viz/Ring';
import SplitBar, { type SplitPart } from './viz/SplitBar';
import type { VizTone } from './viz/tones';
import { useCardSize } from '../hooks/useCardSize';
import { t } from '../lib/i18n';
import { COMPACT } from '../lib/questWords';
import type { QuestGroup } from '@shared/quests';

interface ShelfRow {
  group: QuestGroup;
  pays: { exp: number; unread: boolean };
}

/** The shelves' tones, as their tiles are tinted. */
const SHELF_TONE: Readonly<Record<QuestGroup, VizTone>> = {
  open: 'ok',
  later: 'warn',
  done: 'quiet',
  barred: 'bad'
};

/**
 * The quest book's head, drawn for the card's size: nothing on a small card,
 * the find field and the side chips on a medium one, and on a large one the
 * book in figures over them, a ring of the quests done, the shelves as one
 * split bar, and the exp the open shelf pays. Inside the card, where its size
 * is known. See `mudengine-ui` › `parts/quests.md`.
 */
function QuestBookHead<Row extends ShelfRow>({
  filter,
  groups,
  rows
}: {
  filter: ListFilter<Row>;
  /** The shelves in their order, with their names; held still by the card. */
  groups: ReadonlyArray<{ id: QuestGroup; label: string }>;
  /** The quests the find field and the chips kept. */
  rows: readonly Row[];
}) {
  const size = useCardSize();
  const roomy = size !== 'small';
  // Counted to plain numbers, so the drawing is rebuilt only when one moves.
  const on = (id: QuestGroup): number => rows.filter((row) => row.group === id).length;
  const open = on('open');
  const later = on('later');
  const done = on('done');
  const barred = on('barred');
  const opened = rows.filter((row) => row.group === 'open');
  // Unknown while a class's own rewards are unread: the sum would be a part said as the whole.
  const exp = opened.some((row) => row.pays.unread)
    ? null
    : opened.reduce((sum, row) => sum + row.pays.exp, 0);
  const total = open + later + done + barred;
  const drawn = useMemo(() => {
    const counts: Readonly<Record<QuestGroup, number>> = { open, later, done, barred };
    return {
      arcs: [{ fraction: total === 0 ? 0 : done / total, tone: 'ok' as const }],
      parts: groups.map((group): SplitPart => ({
        key: group.id,
        label: group.label,
        tone: SHELF_TONE[group.id],
        value: counts[group.id]
      }))
    };
  }, [groups, open, later, done, barred, total]);

  return (
    <>
      {size === 'large' && total > 0 ? (
        <section className="quest-summary" aria-label={t('cards.quests.summary.label')}>
          <Ring arcs={drawn.arcs} label={t('cards.quests.summary.ring', { done, total })}>
            {done}/{total}
          </Ring>
          <SplitBar label={t('cards.quests.summary.shelves')} parts={drawn.parts} />
          <Kpi
            hint={t('cards.quests.summary.expHint')}
            label={t('cards.quests.summary.exp')}
            value={exp === null ? null : COMPACT.format(exp)}
          />
        </section>
      ) : null}
      <ListTools
        chips={roomy && filter.present.length > 1}
        filter={filter}
        find={t('cards.quests.find')}
        finding={roomy}
      />
    </>
  );
}

export default QuestBookHead;
