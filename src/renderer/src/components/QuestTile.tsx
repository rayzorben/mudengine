import { memo } from 'react';

import Icon, { type IconName } from './Icon';
import { Reward } from './QuestName';
import { useRunPress } from '../hooks/useRunPress';
import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';
import {
  askWords,
  barWords,
  barsTitle,
  COMPACT,
  progressTitle,
  sideWords
} from '../lib/questWords';
import type {
  QuestAhead,
  QuestBar,
  QuestGroup,
  QuestPays,
  QuestRunProgress,
  QuestSide,
  QuestStep
} from '@shared/quests';

/**
 * One quest of the book, as a tile in the gear card's look (todo 38): tinted
 * by its shelf, the name and counter number in the head, a bar for how far
 * along it is, the next step and its Plan it and Run it, and what it pays
 * along the foot. Hide is the head's quiet control, not a column.
 */
export interface QuestTileProps {
  id: number;
  name: string;
  side: QuestSide;
  group: QuestGroup;
  done: number;
  total: number;
  /** Which reading the figure is: the realm's listing, watching, or the player. */
  observed: boolean;
  watched: boolean;
  bars: readonly QuestBar[];
  ahead: QuestAhead | null;
  /** The character's level, for how many levels off a Later step is. */
  level: number | null;
  pays: QuestPays;
  next: QuestStep | null;
  hidden: boolean;
  open: boolean;
  run: QuestRunProgress | null;
  onOpen(id: number): void;
  onHide(id: number): void;
  onPlan: ((id: number, block: number) => void) | null;
  onRun: ((id: number, block: number) => Promise<string | null>) | null;
  onName?: ((name: string, anchor: HTMLElement) => void) | null;
}

/** The round glyph in the head, one per shelf. */
const GLYPH: Readonly<Record<QuestGroup, IconName>> = {
  open: 'play',
  later: 'stopwatch',
  done: 'check',
  barred: 'close'
};

function QuestTile({
  id,
  name,
  side,
  group,
  done,
  total,
  observed,
  watched,
  bars,
  ahead,
  level,
  pays,
  next,
  hidden,
  open,
  run,
  onOpen,
  onHide,
  onPlan,
  onRun,
  onName
}: QuestTileProps): React.JSX.Element {
  const target = next?.block ?? null;
  const press = useRunPress(
    onRun === null ? null : (block: number) => onRun(id, block),
    target,
    run
  );
  const doing = group === 'open' || group === 'later';
  const act = next === null ? null : askWords(next);
  const off = ahead === null || level === null ? null : ahead.level - level;
  const hideWords = hidden
    ? t('cards.quests.showOne', { name })
    : t('cards.quests.hideOne', { name });
  return (
    <li
      className="quest-tile tile"
      data-hidden={hidden ? 'true' : 'false'}
      data-open={open ? 'true' : 'false'}
      data-state={group}
      title={barsTitle(bars)}
    >
      <header className="quest-tile-head">
        <span aria-hidden="true" className="quest-tile-glyph">
          <Icon name={GLYPH[group]} />
        </span>
        <button
          aria-expanded={open}
          className="quest-tile-name"
          onClick={() => onOpen(id)}
          onMouseDown={keepFocus}
          title={barsTitle(bars) ?? name}
          type="button"
        >
          {name}
        </button>
        <span className="entity-id" title={t('cards.quests.counterTooltip')}>
          {t('cards.quests.counter', { id })}
        </span>
        {side === 'any' ? null : <span className="chip quiet cased">{sideWords(side)}</span>}
        <button
          aria-label={hideWords}
          className="row-action quest-tile-hide"
          onClick={() => onHide(id)}
          onMouseDown={keepFocus}
          title={hideWords}
          type="button"
        >
          <Icon name={hidden ? 'eye' : 'eyeOff'} />
        </button>
      </header>

      {done > 0 && (
        <div className="quest-tile-progress" title={progressTitle({ observed, watched })}>
          <span
            className="quest-tile-track"
            style={{ '--share': total === 0 ? 0 : done / total } as React.CSSProperties}
          />
          <span className="quest-tile-count">
            {done}/{total}
          </span>
        </div>
      )}

      {ahead !== null && (
        <p className="quest-tile-ahead">
          {t('cards.quests.tile.ahead', { rank: ahead.rank, level: ahead.level })}
          {off === null
            ? null
            : off === 1
              ? ` · ${t('cards.quests.tile.levelsOff.one', { count: off })}`
              : ` · ${t('cards.quests.tile.levelsOff.many', { count: off })}`}
        </p>
      )}

      {group === 'barred' && <p className="quest-tile-why">{bars.map(barWords).join(' · ')}</p>}

      {doing && act !== null && target !== null && (
        <div className="quest-tile-next">
          <span className="quest-tile-act">{act}</span>
          {onPlan !== null && (
            <button
              className="quest-plan-btn"
              onClick={() => onPlan(id, target)}
              onMouseDown={keepFocus}
              title={t('cards.quests.plan.buttonTitle')}
              type="button"
            >
              {t('cards.quests.plan.button')}
            </button>
          )}
          {onRun !== null && (
            <button
              className="quest-plan-btn quest-plan-run"
              disabled={press.starting || press.running}
              onClick={press.press}
              onMouseDown={keepFocus}
              title={t('cards.quests.plan.runTitle')}
              type="button"
            >
              {press.starting ? t('cards.quests.plan.runStarting') : t('cards.quests.plan.run')}
            </button>
          )}
        </div>
      )}
      {press.refused !== null && (
        <p className="quiet-note">{t('cards.quests.plan.runRefused', { reason: press.refused })}</p>
      )}

      <footer className="quest-tile-pays">
        {pays.exp > 0 && (
          <span className="quest-tile-exp" title={pays.exp.toLocaleString()}>
            {t('cards.quests.reward.exp', { amount: COMPACT.format(pays.exp) })}
          </span>
        )}
        {pays.rewards.map((reward, at) => (
          <span className="chip quiet cased" key={at}>
            <Reward onName={onName} reward={reward} />
          </span>
        ))}
        {pays.unread && (
          <span className="quest-tile-none" title={t('cards.quests.tile.unreadTitle')}>
            {t('cards.quests.tile.unread')}
          </span>
        )}
        {pays.exp === 0 && pays.rewards.length === 0 && !pays.unread && (
          <span className="quest-tile-none" title={t('cards.quests.tile.paysNothing')}>
            —
          </span>
        )}
      </footer>
    </li>
  );
}

export default memo(QuestTile);
